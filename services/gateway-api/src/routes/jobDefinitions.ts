import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import parser from 'cron-parser';
import { JobTypeSchema, ScheduleSpecSchema, buildCron } from '@conductor/contracts';
import { enqueueJob } from '@conductor/core';
import {
  createJobDefinition,
  listJobDefinitions,
  getJobDefinition,
  setEnabled,
  deleteJobDefinition,
} from '../repos/jobDefinitions.js';
import { audit } from '../audit.js';

const CreateBody = z
  .object({
    projectId: z.string().uuid(),
    entity: z.string().min(1),
    type: JobTypeSchema,
    name: z.string().min(1),
    // Preferred: a friendly recurrence preset (daily/weekly/monthly/…).
    schedule: ScheduleSpecSchema.optional(),
    // Legacy/raw fields (still accepted; ignored when `schedule` is present).
    scheduleKind: z.enum(['cron', 'one_time', 'recurring']).optional(),
    cron: z.string().optional(),
    timezone: z.string().default('UTC'),
    runAt: z.string().datetime().optional(),
    source: z.record(z.string(), z.unknown()).optional(),
    destination: z.record(z.string(), z.unknown()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().default(true),
  })
  .refine(
    (b) => !!b.schedule || (b.scheduleKind === 'one_time' ? !!b.runAt : b.scheduleKind ? !!b.cron : false),
    { message: 'provide a `schedule` preset, or scheduleKind + cron/runAt', path: ['schedule'] },
  );

export async function jobDefinitionRoutes(app: FastifyInstance): Promise<void> {
  const viewer = { preHandler: [app.authenticate, app.requireRole('viewer')] };
  const operator = { preHandler: [app.authenticate, app.requireRole('operator')] };

  app.get('/job-definitions', viewer, async (req) => {
    const { project } = req.query as { project?: string };
    return { definitions: await listJobDefinitions(project) };
  });

  app.get('/job-definitions/:id', viewer, async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = await getJobDefinition(id);
    if (!def) return reply.code(404).send({ error: 'not found' });
    return { definition: def };
  });

  app.post('/job-definitions', operator, async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.flatten() });
    }
    const b = parsed.data;

    // Resolve the schedule: prefer the friendly preset, else legacy raw fields.
    let scheduleKind: 'cron' | 'one_time' | 'recurring';
    let cron: string | null;
    let timezone: string;
    let runAt: string | null;
    if (b.schedule) {
      try {
        const built = buildCron(b.schedule);
        scheduleKind = built.scheduleKind;
        cron = built.cron;
        timezone = built.timezone;
        runAt = built.runAt;
      } catch (err) {
        return reply.code(400).send({ error: `invalid schedule: ${(err as Error).message}` });
      }
    } else {
      scheduleKind = b.scheduleKind!;
      cron = b.cron ?? null;
      timezone = b.timezone;
      runAt = b.runAt ?? null;
    }

    // Validate the cron expression up front so bad schedules never persist.
    let nextRunAt: Date | null = null;
    if (scheduleKind === 'one_time') {
      nextRunAt = runAt ? new Date(runAt) : null;
    } else if (cron) {
      try {
        nextRunAt = parser.parseExpression(cron, { tz: timezone }).next().toDate();
      } catch (err) {
        return reply.code(400).send({ error: `invalid cron: ${(err as Error).message}` });
      }
    }

    // Persist the original preset in options for faithful display/round-trip.
    const options = { ...(b.options ?? {}), ...(b.schedule ? { schedule: b.schedule } : {}) };

    const def = await createJobDefinition(
      {
        projectId: b.projectId,
        entity: b.entity,
        type: b.type,
        name: b.name,
        scheduleKind,
        cron: cron ?? undefined,
        timezone,
        source: b.source,
        destination: b.destination,
        options,
        enabled: b.enabled,
        nextRunAt,
      },
      req.principal!.sub,
    );
    await audit(req.principal, 'job_definition.create', {
      target: def.id,
      projectId: def.project_id,
    });
    return reply.code(201).send({ definition: def });
  });

  app.post('/job-definitions/:id/enable', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = await setEnabled(id, true);
    if (!def) return reply.code(404).send({ error: 'not found' });
    await audit(req.principal, 'job_definition.enable', { target: id });
    return { definition: def };
  });

  app.post('/job-definitions/:id/disable', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = await setEnabled(id, false);
    if (!def) return reply.code(404).send({ error: 'not found' });
    await audit(req.principal, 'job_definition.disable', { target: id });
    return { definition: def };
  });

  // Run-now: enqueue immediately (job + outbox in one tx). Never publishes inline.
  app.post('/job-definitions/:id/run-now', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = await getJobDefinition(id);
    if (!def) return reply.code(404).send({ error: 'not found' });

    const res = await enqueueJob({
      projectId: def.project_id,
      entity: def.entity,
      type: def.type as never,
      definitionId: def.id,
      idempotencyKey: `runnow:${def.id}:${Date.now()}`,
      source: def.source_jsonb,
      destination: def.destination_jsonb,
      options: def.options_jsonb,
    });
    await audit(req.principal, 'job_definition.run_now', {
      target: id,
      projectId: def.project_id,
      jobId: res.jobId ?? undefined,
    });
    return reply.code(202).send({ enqueued: res.enqueued, jobId: res.jobId });
  });

  app.delete('/job-definitions/:id', operator, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deleteJobDefinition(id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await audit(req.principal, 'job_definition.delete', { target: id });
    return reply.code(204).send();
  });
}
