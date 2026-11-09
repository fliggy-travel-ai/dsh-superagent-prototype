/**
 * 用本机安装的 Paseo 真实地构建并加载本插件（#1737：热更新时编译通过、加载报 “Invalid URL”）。
 *
 * 1. 把 Paseo.app 的 app.asar 解到缓存目录（只读副本；首次运行需要 `npx @electron/asar`）。
 * 2. 用其中的插件编译器 `compileDirectoryPlugin` 构建（esbuild 用程序自带的 app.asar.unpacked 二进制）。
 * 3. 用其中的 `evaluateBundle` 按插件进程的方式执行 server 包（`eval` 出 CommonJS 工厂函数，没有 import.meta、__dirname），
 *    再用假的宿主上下文调用一次 contribute，然后立即调用返回的清理函数。
 *
 * 加载时 PASEO_HOME 和插件状态目录指向临时目录，不连接正式 daemon，不读写正式状态，不安装插件。
 * 没有安装 Paseo 时跳过并以 0 退出。
 *
 * 用法：node scripts/check-paseo-load.mjs [--app /Applications/Paseo.app] [--cache <目录>] [--plugin <插件目录>]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const app = args.get('--app') ?? '/Applications/Paseo.app';
const plugin = resolve(args.get('--plugin') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const resources = join(app, 'Contents', 'Resources');
const asar = join(resources, 'app.asar');
if (!existsSync(asar)) { console.log(`跳过：没有找到 Paseo（${asar}）。`); process.exit(0); }

const asarSize = String(statSync(asar).size);
const cache = args.get('--cache') ?? join(tmpdir(), `paseo-app-${asarSize}`);
const compilerPath = join(cache, 'node_modules/@getpaseo/server/dist/server/server/plugins/compiler-build.js');
if (!existsSync(compilerPath)) {
  console.log(`解出 Paseo 程序包到 ${cache} …`);
  const result = spawnSync('npx', ['--yes', '@electron/asar', 'extract', asar, cache], { stdio: 'inherit' });
  if (result.status !== 0 || !existsSync(compilerPath)) { console.error('解出 Paseo 程序包失败'); process.exit(1); }
}
const appVersion = JSON.parse(readFileSync(join(cache, 'package.json'), 'utf8')).version;
process.env.ESBUILD_BINARY_PATH = join(resources, 'app.asar.unpacked/node_modules/@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild');

const { compileDirectoryPlugin } = await import(pathToFileURL(compilerPath).href);
const { evaluateBundle } = await import(pathToFileURL(join(cache, 'node_modules/@getpaseo/server/dist/server/server/plugins/bundle-evaluator.js')).href);

let bundles;
try { bundles = await compileDirectoryPlugin(plugin, appVersion); }
catch (error) { console.error(`构建失败（Paseo ${appVersion}）：${error instanceof Error ? error.message : error}`); process.exit(1); }
console.log(`构建成功（Paseo ${appVersion}）：client ${bundles.clientBundle?.length ?? 0} 字节，server ${bundles.serverBundle?.length ?? 0} 字节`);

const home = mkdtempSync(join(tmpdir(), 'paseo-load-home-'));
process.env.PASEO_HOME = home;
process.env.PASEO_GHSUB_STATE_DIR = join(home, 'github-subscriptions');
delete process.env.PASEO_GHSUB_MACHINE_CONFIG;
const registered = { rpc: 0, providers: [], usageSources: [], hooks: 0, settings: 0 };
const server = {
  handle() { registered.rpc++; },
  registerProvider(provider) { registered.providers.push(provider.id); },
  registerUsageSource(source) { registered.usageSources.push(source.id ?? source.name ?? '?'); },
  registerSettings() { registered.settings++; return { read: async () => ({ status: 'invalid', revision: '0', error: 'load check' }), subscribe: () => () => {} }; },
  addHook() { registered.hooks++; return () => {}; },
  on() { registered.hooks++; return () => {}; },
  before() { registered.hooks++; return () => {}; },
};
let failed = false;
const late = [];
const onLate = error => late.push(error instanceof Error ? error.message : String(error));
process.on('unhandledRejection', onLate);
try {
  const contribute = evaluateBundle(bundles.serverBundle);
  const cleanup = contribute(server);
  await new Promise(r => setTimeout(r, 1500));
  await (typeof cleanup === 'function' ? cleanup() : undefined);
  console.log(`加载成功：注册 RPC ${registered.rpc} 个，Provider ${registered.providers.join('、') || '无'}，额度来源 ${registered.usageSources.length} 个，钩子 ${registered.hooks} 个`);
} catch (error) {
  failed = true;
  console.error(`加载失败：${error instanceof Error ? `${error.name}: ${error.message}` : error}`);
} finally {
  process.off('unhandledRejection', onLate);
  rmSync(home, { recursive: true, force: true });
}
if (late.length) console.log(`加载后的异步错误（临时目录里没有 daemon，属预期）：${[...new Set(late)].slice(0, 5).join('；')}`);
process.exit(failed ? 1 : 0);
