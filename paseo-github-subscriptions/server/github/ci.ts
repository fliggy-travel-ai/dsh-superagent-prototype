import { z } from 'zod';
import { ciCounts, ciFailures, type CiSnapshot } from '../vendor/dsh-superagent/github-read.ts';
import type { GithubClient } from './client.ts';

const RunSchema = z.looseObject({
  id: z.number(), name: z.string().nullish(), status: z.string().nullish(), conclusion: z.string().nullish(),
  head_sha: z.string().nullish(), head_branch: z.string().nullish(), workflow_id: z.number().nullish(), event: z.string().nullish(),
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
  pull_requests: z.array(z.looseObject({ number: z.number() })).nullish(),
});
export type WorkflowRun = z.infer<typeof RunSchema>;
const RunsPageSchema = z.looseObject({ workflow_runs: z.array(z.unknown()) });
const JobsPageSchema = z.looseObject({
  jobs: z.array(z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const CombinedStatusSchema = z.looseObject({
  statuses: z.array(z.looseObject({ context: z.string(), state: z.string() })).nullish(),
});
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

export function parseRuns(body: unknown): WorkflowRun[] {
  const page = RunsPageSchema.safeParse(body);
  if (!page.success) return [];
  return page.data.workflow_runs.flatMap(value => {
    const parsed = RunSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function runSignature(run: WorkflowRun): string {
  return `${run.status ?? ''}:${run.conclusion ?? ''}:${run.updated_at ?? ''}`;
}

export function latestRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const identity = `${run.workflow_id ?? run.name ?? run.id}:${run.event ?? ''}`;
    const known = latest.get(identity);
    if (!known || (run.created_at ?? '') > (known.created_at ?? '') || ((run.created_at ?? '') === (known.created_at ?? '') && run.id > known.id)) {
      latest.set(identity, run);
    }
  }
  return [...latest.values()];
}

export async function readCiSnapshot(client: GithubClient, repository: string, head: string, signal?: AbortSignal): Promise<CiSnapshot> {
  const response = await client.request(`repos/${repository}/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`, { signal });
  const runs = latestRuns(parseRuns(response.json()));
  const checks: CiSnapshot['checks'] = [];
  for (const run of runs) {
    const name = run.name ?? `workflow ${run.id}`;
    if (run.status === 'completed' && PASSING_CONCLUSIONS.has(run.conclusion ?? '')) {
      checks.push({ name, status: 'completed', conclusion: run.conclusion ?? null });
      continue;
    }
    const jobs = await client.get(JobsPageSchema, `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`, signal);
    if (!jobs.jobs.length) {
      checks.push({ name, status: run.status ?? 'queued', conclusion: run.conclusion ?? null });
      continue;
    }
    for (const job of jobs.jobs) checks.push({ name: job.name, status: job.status, conclusion: job.conclusion });
  }
  const combined = await client.get(CombinedStatusSchema, `repos/${repository}/commits/${head}/status`, signal);
  const latest = new Map<string, string>();
  for (const status of combined.statuses ?? []) latest.set(status.context, status.state);
  return {
    head,
    checks: checks.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    statuses: [...latest].map(([context, state]) => ({ context, state })).sort((left, right) => left.context.localeCompare(right.context)),
  };
}

export interface CiState { failures: string[]; revision: number; passedHead: string | null; failedHead: string | null; epoch: number }
export type CiEmit = 'failed' | 'recovered' | 'passed';

export function advanceCi(
  previous: CiState | null, snapshot: CiSnapshot, announcePass: boolean, observedAt: number,
): { state: CiState; emit: CiEmit | null } {
  const failures = ciFailures(snapshot);
  const counts = ciCounts(snapshot);
  const total = snapshot.checks.length + snapshot.statuses.length;
  const settled = counts.running === 0 && failures.length === 0 && total > 0;
  const known = previous ? previous.failures : null;
  const current = failures.length || !counts.running ? failures : known ?? [];
  let emit: CiEmit | null = null;
  if (known && JSON.stringify(current) !== JSON.stringify(known)) emit = current.length ? 'failed' : 'recovered';
  else if (known && failures.length && previous?.failedHead !== snapshot.head) emit = 'failed';
  else if (announcePass && previous && settled && previous.passedHead !== snapshot.head) emit = 'passed';
  const state: CiState = {
    failures: current, revision: (previous?.revision ?? 0) + (emit ? 1 : 0), passedHead: settled ? snapshot.head : null,
    failedHead: failures.length ? snapshot.head : current.length ? previous?.failedHead ?? null : null,
    epoch: previous?.epoch || observedAt,
  };
  return { state, emit };
}
