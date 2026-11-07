// 把实际客户端组件 + 假宿主打成浏览器可运行的预览包（react-native-web）。
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const mocks = path.join(root, 'tests/ui/mocks');

const swap = {
  '@getpaseo/plugin': path.join(mocks, 'plugin-root.ts'),
  '@getpaseo/plugin/client': path.join(mocks, 'plugin-client.tsx'),
  '@getpaseo/plugin/client/ui': path.join(mocks, 'plugin-client-ui.tsx'),
};

const swapPlugin = {
  name: 'swap-plugin-sdk',
  setup(b) {
    b.onResolve({ filter: /^@getpaseo\/plugin(\/client(\/ui)?)?$/ }, (args) => ({ path: swap[args.path] }));
  },
};

await mkdir(path.join(here, 'dist'), { recursive: true });
await build({
  entryPoints: [path.join(here, 'entry.jsx')],
  outfile: path.join(here, 'dist/preview.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  define: { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' },
  loader: { '.js': 'jsx' },
  resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.mjs'],
  alias: {
    // 只留一份 React（客户端用 19.1.0），避免 hook 报错。
    react: path.join(root, 'node_modules/react'),
    'react-native': path.join(here, 'node_modules/react-native-web'),
  },
  plugins: [swapPlugin],
  logLevel: 'info',
});
await copyFile(path.join(here, 'index.html'), path.join(here, 'dist/index.html'));
