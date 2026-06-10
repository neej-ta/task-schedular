import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileUp, Upload, ArrowRight, Database, Wand2 } from 'lucide-react';
import { api, uploadFile } from '../api';
import type { Project } from '../types';
import { Button, Card, Field, Hint, Input, PageHeader, Pill, Select } from '../ui';

interface UploadResult {
  location: string;
  columns: string[];
  sample: Record<string, unknown>[];
  rowCount: number;
}
interface ColumnInfo { name: string; dataType: string; nullable: boolean }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'something went wrong');

export function ImportData({ onOpenJob }: { onOpenJob: (id: string) => void }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: Project[] }>('/projects') });

  const [projectId, setProjectId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [upload, setUpload] = useState<UploadResult | null>(null);

  const [tables, setTables] = useState<string[] | null>(null);
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({}); // sourceCol -> targetCol ('' = skip)
  const [entityName, setEntityName] = useState('');
  const [primaryKey, setPrimaryKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function resetFromUpload() {
    setUpload(null); setTables(null); setTable(''); setColumns(null); setMapping({});
  }

  async function doUpload() {
    if (!projectId || !file) return;
    setErr(null); setUploading(true); resetFromUpload();
    try {
      const res = await uploadFile<UploadResult>('/uploads', file);
      setUpload(res);
      if (!entityName) {
        setEntityName(file.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').toLowerCase() || 'records');
      }
      const t = await api<{ tables: string[] }>(`/projects/${projectId}/tables`);
      setTables(t.tables);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setUploading(false);
    }
  }

  async function pickTable(t: string) {
    setTable(t); setColumns(null); setErr(null);
    if (!t || !upload) return;
    try {
      const c = await api<{ columns: ColumnInfo[] }>(`/projects/${projectId}/tables/${encodeURIComponent(t)}/columns`);
      setColumns(c.columns);
      const auto: Record<string, string> = {};
      for (const src of upload.columns) {
        const m = c.columns.find((col) => col.name.toLowerCase() === src.toLowerCase().replace(/[^a-z0-9]/g, ''));
        const exact = c.columns.find((col) => col.name.toLowerCase() === src.toLowerCase());
        auto[src] = (exact ?? m)?.name ?? '';
      }
      setMapping(auto);
      const pk = c.columns.find((col) => col.name.toLowerCase() === 'id') ?? c.columns[0];
      setPrimaryKey(pk ? pk.name : '');
    } catch (e) {
      setErr(errMsg(e));
    }
  }

  async function run() {
    setErr(null); setBusy(true);
    try {
      const map: Record<string, string> = {};
      for (const [src, tgt] of Object.entries(mapping)) if (tgt) map[src] = tgt;
      if (Object.keys(map).length === 0) throw new Error('Map at least one column to a database field.');
      if (!entityName.trim()) throw new Error('Give this record type a name.');
      if (!primaryKey) throw new Error('Pick a primary key column.');

      await api(`/projects/${projectId}/entities`, {
        method: 'POST',
        body: { name: entityName.trim(), targetTable: table, primaryKey, mapping: map },
      });
      const res = await api<{ jobId: string | null }>(`/jobs`, {
        method: 'POST',
        body: {
          projectId,
          entity: entityName.trim(),
          type: 'bulk_import',
          source: { kind: 'csv', location: upload!.location },
          destination: { kind: 'project_db', table },
          options: { chunkSize: 1000 },
        },
      });
      if (res.jobId) onOpenJob(res.jobId);
      else throw new Error('the job was not enqueued');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const mappedCount = Object.values(mapping).filter(Boolean).length;

  return (
    <div>
      <PageHeader
        title="Import data"
        description="Upload a CSV or Excel file, match its columns to a table in your database, and run the import — no setup scripts needed."
      />

      <div className="grid gap-4">
        {/* Step 1 — connection + file */}
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs text-indigo-700">1</span>
            Choose a connection and a file
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Connection" hint="Where the data will be written">
              <Select
                value={projectId}
                onChange={(e) => { setProjectId(e.target.value); resetFromUpload(); }}
              >
                <option value="">Select a connection…</option>
                {projects.data?.projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.database})</option>
                ))}
              </Select>
            </Field>
            <Field label="File" hint="CSV or Excel (.xlsx)">
              <input
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xlsm"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
              />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button onClick={doUpload} disabled={!projectId || !file || uploading}>
              <Upload className="h-4 w-4" /> {uploading ? 'Uploading…' : 'Upload & detect columns'}
            </Button>
            {upload && (
              <span className="text-sm text-emerald-600">
                ✓ {upload.rowCount.toLocaleString()} rows · {upload.columns.length} columns detected
              </span>
            )}
          </div>
          {upload && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {upload.columns.map((c) => <Pill key={c} tone="slate">{c}</Pill>)}
            </div>
          )}
        </Card>

        {/* Step 2 — target table */}
        {upload && (
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs text-indigo-700">2</span>
              Pick the destination table
            </div>
            {tables && tables.length === 0 ? (
              <Hint>No tables found in this database. Create the destination table first, then re-upload.</Hint>
            ) : (
              <Field label="Table" hint="Columns are read live from your database">
                <Select value={table} onChange={(e) => pickTable(e.target.value)}>
                  <option value="">Select a table…</option>
                  {tables?.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </Field>
            )}
          </Card>
        )}

        {/* Step 3 — field mapping */}
        {upload && columns && (
          <Card className="p-5">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-100 text-xs text-indigo-700">3</span>
              Match columns to database fields
              <Pill tone={mappedCount ? 'green' : 'slate'}>{mappedCount} mapped</Pill>
            </div>
            <Hint>We auto-matched columns with the same name. Adjust any below, or set a column to “skip” to ignore it.</Hint>

            <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Column in your file</th>
                    <th className="px-2 py-2"></th>
                    <th className="px-4 py-2">Database column</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {upload.columns.map((src) => (
                    <tr key={src}>
                      <td className="px-4 py-2 font-medium text-slate-700">{src}</td>
                      <td className="px-2 py-2 text-slate-400"><ArrowRight className="h-4 w-4" /></td>
                      <td className="px-4 py-2">
                        <Select value={mapping[src] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [src]: e.target.value }))}>
                          <option value="">— skip —</option>
                          {columns.map((c) => (
                            <option key={c.name} value={c.name}>{c.name} · {c.dataType}</option>
                          ))}
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Record type (entity) name" hint="A label for this kind of data, e.g. “customer”">
                <Input value={entityName} onChange={(e) => setEntityName(e.target.value)} placeholder="customer" />
              </Field>
              <Field label="Primary key column" hint="The destination table's key column">
                <Select value={primaryKey} onChange={(e) => setPrimaryKey(e.target.value)}>
                  {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </Select>
              </Field>
            </div>

            <div className="mt-4 flex items-center gap-3">
              <Button onClick={run} disabled={busy || mappedCount === 0}>
                <Wand2 className="h-4 w-4" /> {busy ? 'Starting…' : 'Save mapping & import now'}
              </Button>
              <span className="text-xs text-slate-400">
                <Database className="mr-1 inline h-3 w-3" />
                Writes {upload.rowCount.toLocaleString()} rows into <b>{table}</b>
              </span>
            </div>
          </Card>
        )}

        {err && (
          <Card className="border-rose-200 bg-rose-50 p-4">
            <div className="flex items-start gap-2 text-sm text-rose-700">
              <FileUp className="mt-0.5 h-4 w-4 shrink-0" /> {err}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
