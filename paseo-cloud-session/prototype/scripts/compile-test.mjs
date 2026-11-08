import { compileDirectoryPlugin } from "/opt/node22/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/compiler-build.js";
const r = await compileDirectoryPlugin(process.argv[2], "0.15.0");
console.log(JSON.stringify({ manifest: r.manifest, client: r.clientBundle ? Object.keys(r.clientBundle) : null, serverKeys: r.serverBundle && Object.keys(r.serverBundle) }, null, 1));
const code = r.serverBundle?.code ?? r.serverBundle;
console.log(typeof code === "string" ? code.slice(0, 600) : JSON.stringify(r.serverBundle).slice(0, 600));
