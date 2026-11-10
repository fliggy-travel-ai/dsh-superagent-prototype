import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * 机器配置 `~/.paseo/github-subscriptions/machine.json`。
 *
 * 同步读取：Provider 和额度来源必须在 contribute 返回前注册，读配置不能等异步。
 * 结构：`{ version: 1, machine?, modules?: { <模块 ID>: boolean }, <区块名>: ... }`。
 * 每个区块由使用它的模块登记 schema 和默认值；一个区块不合法只停用依赖它的模块。
 * 没有文件时全部用默认值，默认值等于整合前的行为。
 */
export interface SectionSpec<T = unknown> {
  readonly schema: z.ZodType<T>;
  readonly fallback: T;
}

export type SectionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LoadedMachineConfig {
  readonly path: string;
  readonly source: 'file' | 'default';
  readonly machine: string | null;
  /** 显式写入的模块开关；没写的模块用各自默认值。 */
  readonly modules: Readonly<Record<string, boolean>>;
  /** 给用户看的错误，已脱敏，不含文件内容。 */
  readonly errors: readonly string[];
  section<T = unknown>(name: string): SectionResult<T>;
}

const HeaderSchema = z.object({
  version: z.literal(1),
  machine: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/).optional(),
});
const ModulesSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9.-]*$/), z.boolean());

type Read = (path: string) => string;
const defaultRead: Read = path => readFileSync(path, 'utf8');

const issueText = (error: z.ZodError) => error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || '（根）'}：${issue.message}`).join('；');

export function loadMachineConfig(path: string, sections: Readonly<Record<string, SectionSpec>>, read: Read = defaultRead): LoadedMachineConfig {
  const results = new Map<string, SectionResult<unknown>>();
  const errors: string[] = [];
  const build = (source: 'file' | 'default', machine: string | null, modules: Record<string, boolean>): LoadedMachineConfig => ({
    path, source, machine, modules, errors,
    section<T>(name: string): SectionResult<T> {
      const result = results.get(name);
      if (result) return result as SectionResult<T>;
      const spec = sections[name];
      if (!spec) return { ok: false, error: `机器配置区块 ${name} 未登记` };
      return { ok: true, value: spec.fallback as T };
    },
  });
  const failAll = (message: string) => {
    errors.push(message);
    for (const name of Object.keys(sections)) results.set(name, { ok: false, error: message });
  };

  let text: string;
  try {
    text = read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return build('default', null, {});
    failAll(`machine.json 无法读取（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）`);
    return build('file', null, {});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    failAll('machine.json 无法解析：不是合法的 JSON');
    return build('file', null, {});
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    failAll('machine.json 无法解析：根必须是对象');
    return build('file', null, {});
  }
  const header = HeaderSchema.safeParse(raw);
  if (!header.success) {
    failAll(`machine.json 头部无效：${issueText(header.error)}（需要 "version": 1）`);
    return build('file', null, {});
  }
  const record = raw as Record<string, unknown>;
  let modules: Record<string, boolean> = {};
  if (record.modules !== undefined) {
    const parsed = ModulesSchema.safeParse(record.modules);
    if (parsed.success) modules = parsed.data;
    else errors.push(`machine.json 的 modules 无效，模块开关按默认值：${issueText(parsed.error)}`);
  }
  for (const [name, spec] of Object.entries(sections)) {
    if (record[name] === undefined) continue;
    const parsed = spec.schema.safeParse(record[name]);
    if (parsed.success) results.set(name, { ok: true, value: parsed.data });
    else {
      const message = `machine.json 的 ${name} 无效：${issueText(parsed.error)}`;
      errors.push(message);
      results.set(name, { ok: false, error: message });
    }
  }
  return build('file', header.data.machine ?? null, modules);
}
