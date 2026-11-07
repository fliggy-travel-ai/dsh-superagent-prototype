import { z } from 'zod';
import type { Preferences } from '../../shared/model.ts';
import { GithubClient, GithubError } from './client.ts';
import type { CatalogEntry, Directory } from './state.ts';

export const CATALOG_REFRESH_MS = 10 * 60_000;

const OrganizationRepoSchema = z.looseObject({
  full_name: z.string(), name: z.string(), default_branch: z.string().nullish(), archived: z.boolean().nullish(), disabled: z.boolean().nullish(),
});
const SingleRepoSchema = z.looseObject({ full_name: z.string(), default_branch: z.string().nullish() });

export interface CatalogResult {
  directory: Directory;
  repositories: CatalogEntry[];
  previousFetchedAt: number | null;
  error: string | null;
}

const lower = (value: string): string => value.toLowerCase();

export function catalogSignature(preferences: Preferences): string {
  return JSON.stringify([lower(preferences.organization), [...preferences.extraRepos].map(lower).sort()]);
}

export function isExcluded(entry: CatalogEntry, excluded: string[]): boolean {
  const name = lower(entry.name);
  return excluded.some(item => lower(item) === name || lower(item) === name.split('/')[1]);
}

export function mergeCatalog(directory: Directory, preferences: Preferences): CatalogEntry[] {
  const listed = directory.organization.filter(entry => !isExcluded(entry, preferences.excludedRepos));
  const extras = preferences.extraRepos.flatMap(name => directory.extras[lower(name)] ? [directory.extras[lower(name)]!] : []);
  const unique = new Map<string, CatalogEntry>();
  for (const entry of [...listed, ...extras]) unique.set(lower(entry.name), entry);
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadCatalog(
  client: GithubClient, preferences: Preferences, previous: Directory | null, now: number, signal?: AbortSignal,
): Promise<CatalogResult> {
  const signature = catalogSignature(preferences);
  if (previous && previous.signature === signature && now - previous.fetchedAt < CATALOG_REFRESH_MS) {
    return { directory: previous, repositories: mergeCatalog(previous, preferences), previousFetchedAt: previous.fetchedAt, error: null };
  }
  const sameSignature = previous?.signature === signature;
  const errors: string[] = [];
  let organization = previous?.organization ?? [];
  let etag = sameSignature ? previous.etag : null;
  let refreshed = false;
  try {
    const listed = await client.list(`orgs/${preferences.organization}/repos?type=all&per_page=100`, { etag, signal });
    if (listed.status !== 304) {
      organization = listed.items.flatMap(value => {
        const parsed = OrganizationRepoSchema.safeParse(value);
        if (!parsed.success || parsed.data.archived || parsed.data.disabled) return [];
        return [{ name: parsed.data.full_name, defaultBranch: parsed.data.default_branch ?? 'main' }];
      });
      etag = listed.etag;
    }
    refreshed = true;
  } catch (error) {
    if (signal?.aborted || (error instanceof GithubError && (error.rateLimited || error.status === 401))) throw error;
    errors.push(`组织仓库列表：${error instanceof GithubError ? error.message : '读取失败'}`);
  }
  const extras: Directory['extras'] = {};
  for (const name of preferences.extraRepos) {
    const known = previous?.extras[lower(name)];
    if (known) { extras[lower(name)] = known; continue; }
    try {
      const repo = await client.get(SingleRepoSchema, `repos/${name}`, signal);
      extras[lower(name)] = { name: repo.full_name, defaultBranch: repo.default_branch ?? 'main' };
    } catch (error) {
      if (signal?.aborted || (error instanceof GithubError && (error.rateLimited || error.status === 401))) throw error;
      errors.push(`额外仓库 ${name}：${error instanceof GithubError ? error.message : '读取失败'}`);
    }
  }
  const directory: Directory = {
    signature: refreshed ? signature : previous?.signature ?? signature, etag: refreshed ? etag : previous?.etag ?? null, organization, extras,
    fetchedAt: refreshed && !errors.length ? now : previous?.fetchedAt ?? 0,
  };
  return {
    directory, repositories: mergeCatalog(directory, preferences), previousFetchedAt: previous?.fetchedAt ?? null,
    error: errors.length ? errors.join('；') : null,
  };
}
