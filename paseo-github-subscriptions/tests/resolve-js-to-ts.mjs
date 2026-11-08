// 生产环境由 Paseo 打包。复制来的上游文件（server/vendor/paseo-*）用 `./x.js` 导入同目录的 .ts 文件，
// 直接用 Node 跑测试时，把插件目录内的 `./x.js` 解析到存在的 `./x.ts`。需要 Node 22.15 以上（registerHooks）。
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const pluginRoot = new URL('../', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(pluginRoot)) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
  },
});
