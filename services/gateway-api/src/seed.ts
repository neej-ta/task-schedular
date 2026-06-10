import { query } from '@conductor/db';
import { ensureBucket, putObject } from '@conductor/storage';
import { hashPassword } from './auth/password.js';
import { createProject, listProjects } from './repos/projects.js';

// Demo Customer rule set (spec §10): field-local rules + transforms. `unique` is
// DB-enforced at staging; not evaluated in-process.
const CUSTOMER_RULES = {
  rules: [
    { field: 'Email', type: 'required' },
    { field: 'Email', type: 'regex', pattern: '^[^@]+@[^@]+$' },
    { field: 'Age', type: 'required' },
    { field: 'Age', type: 'type', cast: 'integer' },
    { field: 'Age', type: 'range', min: 18 },
    { field: 'Country', type: 'enum', values: ['US', 'UK', 'IN'] },
    { field: 'CustomerCode', type: 'required' },
    { field: 'CustomerCode', type: 'unique', scope: 'table' },
  ],
  transforms: [
    { field: 'Name', op: 'trim' },
    { field: 'Email', op: 'trim' },
    { field: 'Email', op: 'lower' },
    { field: 'JoinDate', op: 'dateFormat', from: 'MM/dd/yyyy', to: 'iso' },
  ],
};

// Sample CSV exercising transforms (case/whitespace/date), a sub-18 row, an
// out-of-enum country, and a DUPLICATE customer_code (C001 on Alice + Frank) to
// demonstrate DB-enforced parallel uniqueness.
const SAMPLE_CSV = `Name,Email,Age,Country,CustomerCode,JoinDate
Alice,  ALICE@EXAMPLE.COM ,30,US,C001,01/15/2020
Bob,bob@example.com,25,UK,C002,02/20/2021
Carol,carol@example.com,17,US,C003,03/10/2019
Dave,dave@example.com,40,FR,C004,04/01/2022
Eve,eve@example.com,35,IN,C005,05/05/2023
Frank,frank@example.com,28,US,C001,06/06/2024
`;

const CUSTOMER_MAPPING = {
  Name: 'customer_name',
  Email: 'email',
  Age: 'age',
  Country: 'country',
  CustomerCode: 'customer_code',
  JoinDate: 'join_date',
};

// XML variant for the xml_integration demo (recordPath = Customers.Customer).
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Customers>
  <Customer><Name>Xml Alice</Name><Email>xml.alice@example.com</Email><Age>31</Age><Country>US</Country><CustomerCode>X001</CustomerCode><JoinDate>01/15/2020</JoinDate></Customer>
  <Customer><Name>Xml Bob</Name><Email>xml.bob@example.com</Email><Age>27</Age><Country>UK</Country><CustomerCode>X002</CustomerCode><JoinDate>02/20/2021</JoinDate></Customer>
  <Customer><Name>Xml Eve</Name><Email>xml.eve@example.com</Email><Age>35</Age><Country>IN</Country><CustomerCode>X003</CustomerCode><JoinDate>05/05/2023</JoinDate></Customer>
</Customers>
`;

// Inbound file the file_inbound demo fetches → stages → enqueues bulk_import.
const INBOUND_CSV = `Name,Email,Age,Country,CustomerCode,JoinDate
Inbound One,inb1@example.com,40,US,INB1,03/03/2021
Inbound Two,inb2@example.com,41,UK,INB2,03/03/2021
`;

// Updates existing C001/C002/C005 (match on customer_code) + one not-found (CZZZ).
const UPDATE_CSV = `Name,Email,Age,Country,CustomerCode,JoinDate
Alice Updated,alice@example.com,33,UK,C001,01/15/2020
Bob Updated,bob@example.com,26,US,C002,02/20/2021
Eve Updated,eve@example.com,36,IN,C005,05/05/2023
Missing Person,missing@example.com,50,US,CZZZ,01/01/2020
`;

// Keys to (soft-)delete by customer_code.
const DELETE_CSV = `Name,Email,Age,Country,CustomerCode,JoinDate
x,x1@example.com,30,US,C002,01/01/2020
x,x2@example.com,30,US,C004,01/01/2020
`;

const MOCK_REST_URL = process.env.MOCK_REST_URL ?? 'http://mock-rest:4000/customers';

// Idempotent dev seed (spec §19): an admin user + a demo Project pointing at the
// second `demo-target` Postgres. Re-running makes no duplicates.
export async function seed(log: (m: string) => void = console.log): Promise<void> {
  // ── Admin user ──────────────────────────────────────────────────────────────
  const adminEmail = 'admin@conductor.local';
  const { rows: existingUsers } = await query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [adminEmail],
  );
  if (existingUsers.length === 0) {
    const hash = await hashPassword('admin123');
    await query(
      `INSERT INTO users(email, display_name, role, password_hash)
       VALUES ($1, $2, 'admin', $3)`,
      [adminEmail, 'Demo Admin', hash],
    );
    log(`[seed] created admin user ${adminEmail} (password: admin123)`);
  } else {
    log('[seed] admin user already exists');
  }

  // Also seed an operator and a viewer to exercise RBAC.
  for (const [email, role] of [
    ['operator@conductor.local', 'operator'],
    ['viewer@conductor.local', 'viewer'],
  ] as const) {
    const { rows } = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (rows.length === 0) {
      await query(
        `INSERT INTO users(email, display_name, role, password_hash) VALUES ($1,$2,$3,$4)`,
        [email, `Demo ${role}`, role, await hashPassword(`${role}123`)],
      );
      log(`[seed] created ${role} user ${email} (password: ${role}123)`);
    }
  }

  // ── Demo project → demo-target Postgres ───────────────────────────────────────
  const projects = await listProjects();
  let demo = projects.find((p) => p.name === 'Demo (demo-target)');
  if (!demo) {
    demo = await createProject(
      {
        name: 'Demo (demo-target)',
        description: 'Seeded demo project pointing at the local demo-target Postgres.',
        environment: 'test',
        provider: 'postgres',
        host: process.env.DEMO_TARGET_HOST ?? 'demo-target',
        port: Number(process.env.DEMO_TARGET_PORT ?? 5432),
        database: process.env.DEMO_TARGET_DB ?? 'demo',
        username: process.env.DEMO_TARGET_USER ?? 'demo',
        secret: process.env.DEMO_TARGET_PASSWORD ?? 'demo_dev_pw',
        sslMode: 'disable',
        // Allow the docker-network hostname even though it resolves to a private IP.
        allowlistHosts: [process.env.DEMO_TARGET_HOST ?? 'demo-target'],
      },
      null,
    );
    log('[seed] created demo project → demo-target');
  } else {
    log('[seed] demo project already exists');
  }

  // ── Customer rule set (versioned) ─────────────────────────────────────────────
  let ruleSetId: string;
  const { rows: rsRows } = await query<{ id: string }>(
    `SELECT id FROM rule_sets WHERE project_id=$1 AND entity='Customer' AND version=1`,
    [demo.id],
  );
  if (rsRows.length === 0) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO rule_sets (project_id, entity, version, rules_jsonb, status)
       VALUES ($1,'Customer',1,$2,'active') RETURNING id`,
      [demo.id, JSON.stringify(CUSTOMER_RULES)],
    );
    ruleSetId = rows[0]!.id;
    log('[seed] created Customer rule set v1');
  } else {
    ruleSetId = rsRows[0]!.id;
  }

  // ── Customer entity + mapping ─────────────────────────────────────────────────
  const { rows: entRows } = await query<{ id: string }>(
    `SELECT id FROM project_entities WHERE project_id=$1 AND name='Customer'`,
    [demo.id],
  );
  if (entRows.length === 0) {
    await query(
      `INSERT INTO project_entities (project_id, name, target_table, primary_key, rule_set_id, mapping_jsonb)
       VALUES ($1,'Customer','customers','id',$2,$3)`,
      [demo.id, ruleSetId, JSON.stringify(CUSTOMER_MAPPING)],
    );
    log('[seed] created Customer entity + mapping');
  }

  // ── Sample files → object storage (S3-compatible: SeaweedFS locally) ──────────
  try {
    // On first boot the object store may still be coming up; retry the bucket
    // check so the file-based demo jobs always have their source files staged.
    let lastErr: unknown;
    for (let i = 0; i < 30; i++) {
      try {
        await ensureBucket();
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (i === 0) log('[seed] waiting for object storage…');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (lastErr) throw lastErr;
    await putObject('customers.csv', SAMPLE_CSV);
    await putObject('customers.xml', SAMPLE_XML);
    await putObject('inbound/customers_inbound.csv', INBOUND_CSV);
    await putObject('customers_update.csv', UPDATE_CSV);
    await putObject('customers_delete.csv', DELETE_CSV);
    log('[seed] uploaded sample files (csv/xml/inbound/update/delete) to object storage');
  } catch (err) {
    log(`[seed] WARN: could not upload sample files: ${(err as Error).message}`);
  }

  // ── Demo job definitions, one per handler type (Run-now to exercise) ──────────
  const dest = { kind: 'project_db', table: 'customers' };
  const restDest = { kind: 'rest', location: MOCK_REST_URL, options: { batchSize: 50 } };
  const defs: Array<{ name: string; type: string; source: unknown; destination: unknown; options: unknown }> = [
    { name: 'Demo customer import', type: 'bulk_import', source: { kind: 'csv', location: 's3://uploads/customers.csv' }, destination: dest, options: { chunkSize: 2 } },
    { name: 'Demo bulk insert', type: 'bulk_insert', source: { kind: 'csv', location: 's3://uploads/customers.csv' }, destination: dest, options: { chunkSize: 50 } },
    { name: 'Demo XML integration', type: 'xml_integration', source: { kind: 'xml', location: 's3://uploads/customers.xml', options: { recordPath: 'Customers.Customer' } }, destination: dest, options: { chunkSize: 50 } },
    { name: 'Demo bulk update', type: 'bulk_update', source: { kind: 'csv', location: 's3://uploads/customers_update.csv' }, destination: dest, options: { chunkSize: 50, matchOn: 'customer_code' } },
    { name: 'Demo bulk delete (dry-run)', type: 'bulk_delete', source: { kind: 'csv', location: 's3://uploads/customers_delete.csv' }, destination: dest, options: { chunkSize: 50, matchOn: 'customer_code', dryRun: true } },
    { name: 'Demo bulk delete (soft)', type: 'bulk_delete', source: { kind: 'csv', location: 's3://uploads/customers_delete.csv' }, destination: dest, options: { chunkSize: 50, matchOn: 'customer_code' } },
    { name: 'Demo file inbound', type: 'file_inbound', source: { kind: 's3', location: 's3://uploads/inbound/customers_inbound.csv' }, destination: dest, options: { chunkSize: 50 } },
    { name: 'Demo file outbound', type: 'file_outbound', source: { kind: 'project_db' }, destination: { kind: 's3', location: 's3://uploads/exports/customers.csv', options: { format: 'csv' } }, options: {} },
    { name: 'Demo REST pull', type: 'rest_pull', source: { kind: 'rest', location: MOCK_REST_URL, options: { pageSize: 3 } }, destination: dest, options: { chunkSize: 50 } },
    { name: 'Demo REST push', type: 'rest_push', source: { kind: 'project_db' }, destination: restDest, options: {} },
  ];

  for (const d of defs) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM job_definitions WHERE project_id=$1 AND name=$2`,
      [demo.id, d.name],
    );
    if (rows.length === 0) {
      await query(
        `INSERT INTO job_definitions
           (project_id, entity, type, name, schedule_kind, enabled, source_jsonb, destination_jsonb, options_jsonb)
         VALUES ($1,'Customer',$2,$3,'one_time',true,$4,$5,$6)`,
        [demo.id, d.type, d.name, JSON.stringify(d.source), JSON.stringify(d.destination), JSON.stringify(d.options)],
      );
      log(`[seed] created definition "${d.name}" (${d.type})`);
    }
  }

  log('[seed] done');
}
