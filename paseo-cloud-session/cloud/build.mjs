import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({entryPoints:['src/main.js'],outfile:'dist/paseo-cloud-session.mjs',bundle:true,platform:'node',format:'esm',target:'node22',nodePaths:[resolve('node_modules')],banner:{js:'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'}});
