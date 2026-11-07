import { z } from 'zod';

const StreamSchema = z.object({ since: z.string(), etag: z.string().nullable() });
const CiStateSchema = z.object({
  failures: z.array(z.string()), revision: z.number(), passedHead: z.string().nullable(),
  failedHead: z.string().nullable().default(null), epoch: z.number().default(0),
});
const ThreadSnapshotSchema = z.object({
  state: z.enum(['open', 'closed', 'merged']), title: z.string(), isPr: z.boolean(), updatedAt: z.string(),
});
const PullSnapshotSchema = z.object({
  head: z.string(), title: z.string(), closed: z.boolean(), reviews: z.array(z.number()).nullable(), ci: CiStateSchema.nullable(),
  pullDirty: z.boolean(), reviewsDirty: z.boolean(), ciDirty: z.boolean(),
  reconciledAt: z.number().default(0), ciReconciledAt: z.number().default(0),
});
const BranchSnapshotSchema = z.object({ name: z.string(), ci: CiStateSchema.nullable(), dirty: z.boolean(), reconciledAt: z.number().default(0) });
const RepositoryStateSchema = z.object({
  started: z.string(),
  streams: z.record(z.string(), StreamSchema),
  runs: z.object({ etag: z.string().nullable(), signatures: z.record(z.string(), z.string()) }).nullable(),
  threads: z.record(z.string(), ThreadSnapshotSchema),
  pulls: z.record(z.string(), PullSnapshotSchema),
  branch: BranchSnapshotSchema.nullable(),
});
const CatalogEntrySchema = z.object({ name: z.string(), defaultBranch: z.string() });
const DirectorySchema = z.object({
  signature: z.string(), etag: z.string().nullable(), fetchedAt: z.number(),
  organization: z.array(CatalogEntrySchema), extras: z.record(z.string(), CatalogEntrySchema),
});
export const SourceStateSchema = z.object({
  version: z.literal(1),
  directory: DirectorySchema.nullable(),
  repos: z.record(z.string(), RepositoryStateSchema),
  seen: z.record(z.string(), z.number()),
});

export type StreamState = z.infer<typeof StreamSchema>;
export type ThreadSnapshot = z.infer<typeof ThreadSnapshotSchema>;
export type PullSnapshot = z.infer<typeof PullSnapshotSchema>;
export type RepositoryState = z.infer<typeof RepositoryStateSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type Directory = z.infer<typeof DirectorySchema>;
export type SourceState = z.infer<typeof SourceStateSchema>;

export const emptyState = (): SourceState => ({ version: 1, directory: null, repos: {}, seen: {} });

export function loadState(value: unknown): SourceState {
  const parsed = SourceStateSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyState();
}

export const emptyRepositoryState = (started: string): RepositoryState => ({
  started, streams: {}, runs: null, threads: {}, pulls: {}, branch: null,
});
