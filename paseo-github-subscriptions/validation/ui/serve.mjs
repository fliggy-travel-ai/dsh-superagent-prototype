// 本机静态服务，只监听 127.0.0.1。用法：node serve.mjs [端口]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const port = Number(process.argv[2] ?? 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json' };

createServer(async (req, res) => {
  const name = new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/+$/, '/index.html');
  const file = path.join(dist, path.normalize(name).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(dist)) return void res.writeHead(403).end();
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`预览服务 http://127.0.0.1:${port}/  （fixture，非生产）`));
