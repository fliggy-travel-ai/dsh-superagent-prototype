/**
 * 部署开发自动化插件的一个实例。
 *
 *   node --experimental-strip-types scripts/deploy.ts --role main|provider --ref <标签或提交> \
 *     [--target <部署目录>] [--install] [--reload] [--host <守护进程>] [--paseo <paseo 命令路径>] [--dry-run]
 *
 * 步骤：
 * 1. 从 `--ref` 用 git archive 导出 paseo-github-subscriptions 到临时目录；
 * 2. 写角色文件 shared/instance.ts 和 .deployment.json，安装运行依赖；
 * 3. 检查旧实例和新实例托管的 Provider 有没有运行中的轮次；要重载且有运行中轮次时停止，不替换目录；
 * 4. 旧目录改名为 `<目录>.prev-<时间>`，新目录放到位；
 * 5. `--install`：插件未安装时安装到这个目录；`--reload`：重载插件并检查状态。
 *
 * 默认目录：main → ~/.paseo/local-plugins/github-subscriptions；provider → ~/.paseo/local-plugins/dev-automation-providers。
 * 插件状态目录（~/.paseo/github-subscriptions）不动。不重启 Paseo。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeployArgs, pluginIdFor, providersHostedBy, readRoleFile, roleFileContent, runningTurns, type AgentRow, type DeployOptions } from './deploy-lib.ts';

const PLUGIN_DIRECTORY = 'paseo-github-subscriptions';

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function paseo(options: DeployOptions, args: string[]): string {
  return run(options.paseo, [...args, ...(options.host ? ['--host', options.host] : [])]);
}

function installedRole(target: string) {
  const file = join(target, 'shared', 'instance.ts');
  return readRoleFile(existsSync(file) ? readFileSync(file, 'utf8') : null);
}

function main() {
  const options = parseDeployArgs(process.argv.slice(2), homedir());
  const repo = run('git', ['rev-parse', '--show-toplevel'], dirname(fileURLToPath(import.meta.url))).trim();
  const commit = run('git', ['rev-parse', '--verify', `${options.ref}^{commit}`], repo).trim();
  const pluginId = pluginIdFor(options.role);
  const previousRole = existsSync(options.target) ? installedRole(options.target) : null;
  const hosted = [...new Set([...(existsSync(options.target) ? providersHostedBy(previousRole) : []), ...providersHostedBy(options.role)])];
  console.log(`部署 ${pluginId}（角色 ${options.role}）：${options.ref} → ${commit.slice(0, 12)}，目录 ${options.target}`);
  console.log(`需要检查运行中轮次的 Provider：${hosted.length ? hosted.join('、') : '无'}`);
  if (options.dryRun) { console.log('试运行：不导出、不替换、不重载。'); return; }

  if (options.reload && hosted.length) {
    const agents = JSON.parse(paseo(options, ['agent', 'ls', '-g', '--background', '--json'])) as AgentRow[];
    const busy = runningTurns(agents, hosted);
    if (busy.length) {
      for (const agent of busy) console.error(`运行中：${agent.name ?? agent.id}（${agent.provider}）`);
      console.error(`停止：上面 ${busy.length} 个会话正在执行，重载会让这一轮失败。等它们空闲后再部署。`);
      process.exitCode = 2;
      return;
    }
  }

  const work = mkdtempSync(join(tmpdir(), 'dev-automation-deploy-'));
  const staging = `${options.target}.staging-${Date.now()}`;
  try {
    const archive = join(work, 'plugin.tar');
    run('git', ['archive', '--format=tar', '-o', archive, commit, PLUGIN_DIRECTORY], repo);
    run('mkdir', ['-p', staging]);
    run('tar', ['-xf', archive, '-C', staging, '--strip-components=1']);
    writeFileSync(join(staging, 'shared', 'instance.ts'), roleFileContent(options.role));
    writeFileSync(join(staging, '.deployment.json'), `${JSON.stringify({ pluginId, role: options.role, ref: options.ref, commit, deployedAt: new Date().toISOString() }, null, 2)}\n`);
    console.log('安装运行依赖……');
    run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], staging);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (existsSync(options.target)) {
    const previous = `${options.target}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(options.target, previous);
    console.log(`旧版本保留在 ${previous}`);
  }
  renameSync(staging, options.target);
  console.log(`已放到 ${options.target}`);

  const listed = () => (JSON.parse(paseo(options, ['plugin', 'ls', '--json'])) as { id: string; path: string; status: string }[]).find(plugin => plugin.id === pluginId);
  if (options.install || options.reload) {
    const current = listed();
    if (!current) {
      if (!options.install) { console.log(`${pluginId} 尚未安装。安装命令：${options.paseo} plugin install ${options.target} --id ${pluginId}`); return; }
      paseo(options, ['plugin', 'install', options.target, '--id', pluginId]);
    } else if (current.path !== options.target) {
      console.log(`${pluginId} 当前安装在 ${current.path}，不是本次部署目录。改装需要先 remove 再 install，请人工确认后执行。`);
      return;
    } else if (options.reload) {
      paseo(options, ['plugin', 'reload', pluginId]);
    }
    const after = listed();
    console.log(`${pluginId} 状态：${after?.status ?? '未找到'}`);
    if (after?.status !== 'running') process.exitCode = 1;
  } else {
    console.log(`未重载。生效需要：${options.paseo} plugin reload ${pluginId}${options.host ? ` --host ${options.host}` : ''}`);
  }
}

try { main(); }
catch (error) { console.error(`部署失败：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
