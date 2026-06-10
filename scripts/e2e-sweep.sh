#!/usr/bin/env bash
# Comprehensive end-to-end acceptance sweep across M1–M6 + scheduler presets +
# RBAC matrix + edge cases. API-driven (parses job error_summary for counts),
# with a couple of docker-exec checks for DB/Redis state. Tallies PASS/FAIL.
set -u
API=localhost:8080
PASS=0; FAIL=0
J() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1" 2>/dev/null; }
chk() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 (got '$2', want '$3')"; FAIL=$((FAIL+1)); fi; }
chkc() { if echo "$2" | grep -q "$3"; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 (got '$2', want contains '$3')"; FAIL=$((FAIL+1)); fi; }
login() { curl -s -X POST $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}" | J .token; }
http() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

ADMIN=$(login admin@conductor.local admin123)
OP=$(login operator@conductor.local operator123)
VIEW=$(login viewer@conductor.local viewer123)
AUTHA="-H \"Authorization: Bearer $ADMIN\""
PID=$(curl -s $API/projects -H "Authorization: Bearer $ADMIN" | J ".projects.find(p=>p.name.startsWith('Demo')).id")
defid() { curl -s "$API/job-definitions" -H "Authorization: Bearer $ADMIN" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).definitions.find(d=>d.name===process.argv[1])?.id||''" "$1"; }
run_def() { local id=$(defid "$1"); local tok=${2:-$ADMIN}; local job=$(curl -s -X POST "$API/job-definitions/$id/run-now" -H "Authorization: Bearer $tok" | J .jobId); for i in $(seq 1 60); do local st=$(curl -s $API/jobs/$job -H "Authorization: Bearer $ADMIN" | J .job.status); [ "$st" = completed -o "$st" = failed ] && break; sleep 0.5; done; curl -s $API/jobs/$job -H "Authorization: Bearer $ADMIN" | J .job.error_summary; }

echo "===== AUTH / RBAC matrix ====="
chk "admin login" "$([ -n "$ADMIN" ] && echo ok)" ok
chk "operator login" "$([ -n "$OP" ] && echo ok)" ok
chk "viewer login" "$([ -n "$VIEW" ] && echo ok)" ok
chk "bad password → 401" "$(http -X POST $API/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@conductor.local","password":"nope"}')" 401
chk "no token → 401 on /projects" "$(http $API/projects)" 401
chk "viewer GET /projects → 200" "$(http $API/projects -H "Authorization: Bearer $VIEW")" 200
chk "viewer POST /projects → 403 (admin only)" "$(http -X POST $API/projects -H "Authorization: Bearer $VIEW" -H 'Content-Type: application/json' -d '{}')" 403
chk "operator POST /projects → 403 (admin only)" "$(http -X POST $API/projects -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' -d '{}')" 403
chk "viewer run-now → 403 (operator+)" "$(http -X POST $API/job-definitions/$(defid 'Demo customer import')/run-now -H "Authorization: Bearer $VIEW")" 403
chk "viewer dlq/replay → 403" "$(http -X POST $API/dlq/replay -H "Authorization: Bearer $VIEW" -H 'Content-Type: application/json' -d '{}')" 403

echo "===== M1: projects / secret / SSRF ====="
chk "secret masked in API" "$(curl -s $API/projects -H "Authorization: Bearer $ADMIN" | J ".projects[0].secretMasked")" "••••••••"
chk "test-connection (IP-pinned) ok" "$(curl -s -X POST $API/projects/$PID/test-connection -H "Authorization: Bearer $OP" | J .ok)" true
SP=$(curl -s -X POST $API/projects -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"name":"ssrf","provider":"postgres","host":"169.254.169.254","port":5432,"database":"x","username":"x","secret":"x"}' | J .project.id)
chk "SSRF metadata test-conn → 403" "$(http -X POST $API/projects/$SP/test-connection -H "Authorization: Bearer $OP")" 403
curl -s -o /dev/null -X DELETE $API/projects/$SP -H "Authorization: Bearer $ADMIN"

echo "===== M3: bulk_import + idempotency + parallel-uniqueness ====="
docker compose exec -T demo-target psql -U demo -d demo -c "TRUNCATE customers RESTART IDENTITY;" >/dev/null 2>&1
S1=$(run_def "Demo customer import"); chkc "import 3/6 (dirty CSV: age/enum/dup errors)" "$S1" "imported 3/6 rows, 3 row errors"
S2=$(run_def "Demo customer import"); chkc "re-import idempotent (0 new)" "$S2" "imported 0/6 rows"
ROWS=$(docker compose exec -T demo-target psql -U demo -d demo -t -c "SELECT count(*) FROM customers;" | tr -d ' \r')
chk "target has exactly 3 rows (no dup despite 2 runs)" "$ROWS" 3

echo "===== M5: all handler types ====="
chkc "xml_integration 3/3" "$(run_def 'Demo XML integration')" "imported 3/3 rows"
chkc "bulk_insert idempotent (0 new)" "$(run_def 'Demo bulk insert')" "imported 0/6 rows"
chkc "bulk_update 3/4 (1 not_found)" "$(run_def 'Demo bulk update')" "updated 3/4 rows, 1 errors"
chkc "bulk_delete dry-run (no mutation)" "$(run_def 'Demo bulk delete (dry-run)')" "dry-run"
chkc "bulk_delete soft-delete" "$(run_def 'Demo bulk delete (soft)')" "soft-deleted"
chkc "file_inbound → enqueues import" "$(run_def 'Demo file inbound')" "enqueued bulk_import"
chkc "file_outbound exports" "$(run_def 'Demo file outbound')" "exported"
chkc "rest_pull paginates + enqueues insert" "$(run_def 'Demo REST pull')" "enqueued bulk_insert"
chkc "rest_push pushes" "$(run_def 'Demo REST push')" "pushed"

echo "===== scheduler presets → cron ====="
mkcron() { curl -s -X POST $API/job-definitions -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d "{\"name\":\"sweep-$1-$RANDOM\",\"projectId\":\"$PID\",\"entity\":\"Customer\",\"type\":\"bulk_import\",\"source\":{\"kind\":\"csv\",\"location\":\"s3://uploads/customers.csv\"},\"destination\":{\"kind\":\"project_db\",\"table\":\"customers\"},\"schedule\":$2}" | J .definition.cron; }
chk "daily 09:30 → cron" "$(mkcron daily '{"kind":"daily","time":"09:30"}')" "30 9 * * *"
chk "weekly Mon,Fri 08:00 → cron" "$(mkcron weekly '{"kind":"weekly","time":"08:00","daysOfWeek":[1,5]}')" "0 8 * * 1,5"
chk "monthly 15th → cron" "$(mkcron monthly '{"kind":"monthly","time":"06:00","dayOfMonth":15}')" "0 6 15 * *"
# disable the sweep defs we just created
for id in $(curl -s "$API/job-definitions" -H "Authorization: Bearer $ADMIN" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).definitions.filter(d=>d.name.startsWith('sweep-')).map(d=>d.id).join('\n')"); do curl -s -o /dev/null -X POST $API/job-definitions/$id/disable -H "Authorization: Bearer $ADMIN"; done

echo "===== M6: concurrency / DLQ / metrics ====="
chk "metrics endpoint (gateway)" "$(http $API/metrics)" 200
chk "worker-core /metrics" "$(http localhost:9101/metrics)" 200
chk "prometheus targets healthy" "$(curl -s 'localhost:9090/api/v1/targets' | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).data.activeTargets.every(t=>t.health==='up')")" true
chk "grafana healthy" "$(http localhost:3001/api/health)" 200
chk "GET /workers (2 pools)" "$(curl -s $API/workers -H "Authorization: Bearer $ADMIN" | J ".workers.length>=2")" true
chk "GET /queues incl dlq" "$(curl -s $API/queues -H "Authorization: Bearer $ADMIN" | J ".queues.some(q=>q.name.endsWith('.dlq'))")" true

echo "===== edge case: empty (header-only) CSV ====="
node -e "const{S3Client,PutObjectCommand}=require('@aws-sdk/client-s3');(async()=>{const s3=new S3Client({endpoint:'http://localhost:9000',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:'conductor',secretAccessKey:'conductor_dev_pw'}});await s3.send(new PutObjectCommand({Bucket:'uploads',Key:'empty.csv',Body:'Name,Email,Age,Country,CustomerCode,JoinDate\n'}));})()" 2>/dev/null
EJOB=$(curl -s -X POST $API/jobs -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' -d "{\"projectId\":\"$PID\",\"entity\":\"Customer\",\"type\":\"bulk_import\",\"source\":{\"kind\":\"csv\",\"location\":\"s3://uploads/empty.csv\"},\"destination\":{\"kind\":\"project_db\",\"table\":\"customers\"}}" | J .jobId)
for i in $(seq 1 30); do est=$(curl -s $API/jobs/$EJOB -H "Authorization: Bearer $ADMIN" | J .job.status); [ "$est" = completed -o "$est" = failed ] && break; sleep 0.5; done
chk "empty CSV import completes" "$est" completed
chkc "empty CSV → 0 rows" "$(curl -s $API/jobs/$EJOB -H "Authorization: Bearer $ADMIN" | J .job.error_summary)" "0/0 rows"

echo ""
echo "===== SWEEP RESULT: $PASS passed, $FAIL failed ====="
[ "$FAIL" -eq 0 ]
