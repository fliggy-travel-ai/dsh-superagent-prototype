import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ProviderEventSchema } from '../node_modules/@getpaseo/plugin/dist/server/provider.js';
import { mapper, ForwardQueue, hook, install, wait, mcp } from '../dist/paseo-cloud-session.mjs';
const env={PASEO_MINI_HOST:'https://app.paseo.sh/#offer=FAKE-SECRET',CLAUDE_CODE_REMOTE_SESSION_ID:'cse_test12345678'};
const rows=(await readFile(new URL('../../fixtures/transcript-sample.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
test('样例映射两轮、文本和工具结果',()=>{
 const map=mapper(), batches=rows.map(map).filter(Boolean), items=batches.flatMap(x=>x.items);
 for (const item of items) ProviderEventSchema.parse({type:'timeline.item',sessionId:'test',item});
 assert.equal(batches.filter(x=>x.startTurn).length,2); assert.equal(batches.filter(x=>x.endTurn==='completed').length,2);
 assert.equal(items.filter(x=>x.type==='user_message').length,2); assert.ok(items.some(x=>x.type==='reasoning' && x.text));
 assert.ok(items.some(x=>x.type==='assistant_message')); const calls=items.filter(x=>x.type==='tool_call');
 assert.ok(calls.some(x=>x.name==='Read' && x.detail.type==='read' && x.status==='completed'));
 const failed=calls.find(x=>x.status==='failed'); assert.equal(failed.detail.type,'shell'); assert.ok(calls.some(x=>x.callId===failed.callId && x.status==='running'));
});
test('注册条件与不可达输出',async()=>{
 const input={transcript_path:'missing',source:'startup'}; let invoked=0; const rpc=async()=>{invoked++;throw Error(env.PASEO_MINI_HOST)};
 for(const e of [{...env,PASEO_MINI_HOST:''},{...env,PASEO_AGENT_ID:'existing'},{...env,CLAUDE_CODE_REMOTE_SESSION_ID:''}]) assert.equal(await hook(input,e,rpc,false),'');
 assert.equal(invoked,0); const result=await hook(input,env,rpc,false); assert.equal(result.trim().split('\n').length,1); assert.ok(!result.includes(env.PASEO_MINI_HOST));
});
test('安装保留配置且重复运行不重复',async()=>{
 const home=await mkdtemp(join(tmpdir(),'paseo-install-test-')); try {await mkdir(join(home,'.claude')); await writeFile(join(home,'.claude/settings.json'),JSON.stringify({other:7,hooks:{SessionStart:[{hooks:[{type:'command',command:'existing'}]}]}})); let added=0;
 const run=(_cmd,args)=>{if(args[1]==='get' && !added) throw Error(); if(args[1]==='add') added++;};
 await install(home,'/opt/example.mjs',run); await install(home,'/opt/example.mjs',run);
 const settings=JSON.parse(await readFile(join(home,'.claude/settings.json'),'utf8')); assert.equal(settings.other,7); assert.equal(settings.hooks.SessionStart.length,2); assert.equal(added,1);
 } finally {await rm(home,{recursive:true,force:true});}
});
test('断线失败后恢复，按顺序补推未成功条目',async()=>{
 let fail=true; const accepted=[]; const rpc=async(_contract,value)=>{if(fail){fail=false;throw Error('offline');} accepted.push(value); return {accepted:value.items.length};};
 const q=new ForwardQueue(rpc,env); for(const row of rows) q.add(row); const count=q.pending.length; await assert.rejects(q.flush()); assert.equal(q.pending.length,count); await q.flush(); assert.equal(accepted.length,count); assert.equal(q.pending.length,0); assert.equal(accepted.filter(x=>x.startTurn).length,2);
});
test('wait 输出原文并确认、epoch 变化、不可达重试',async()=>{
 const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_waittest'+Date.now()}; const output=[]; let offline=true, ack=0, epoch='one'; let sleeps=0;
 const rpc=async(c,input)=>{if(c.name.endsWith('ensure')) {if(offline){offline=false;throw Error(env.PASEO_MINI_HOST)} return {};}
 if(c.name.endsWith('poll')) return {epoch,items:[{seq:1,delivery:'steer',text:'<paseo-system>原文</paseo-system>'}],lastSeq:1}; if(c.name.endsWith('ack')) {ack=input.seq; return {};} };
 const opts={print:s=>output.push(s),sleep:async()=>{sleeps++;}}; await wait(e,rpc,opts); assert.equal(ack,1); assert.equal(sleeps,1); assert.match(output[0],/seq: 1 delivery: steer\n<paseo-system>原文/);
 epoch='two'; await wait(e,rpc,opts); assert.ok(output.some(s=>s.includes('Mac 上的插件重启过'))); assert.ok(!output.join('\n').includes(env.PASEO_MINI_HOST));
});
test('MCP 本地初始化、代理和错误不泄露配对链接',async()=>{
 let result=''; const input=Readable.from([JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}})+'\n'+JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n']);
 const output=new Writable({write(chunk,_enc,cb){result+=chunk;cb();}}); await mcp(env,async()=>{throw Error(env.PASEO_MINI_HOST)},input,output);
 const lines=result.trim().split('\n').map(JSON.parse); assert.equal(lines[0].result.serverInfo.name,'paseo'); assert.ok(lines[1].error); assert.ok(!result.includes(env.PASEO_MINI_HOST));
});

test('MCP 初始化代理后转发工具并保留响应',async()=>{
 const methods=[]; let outputText=''; const input=Readable.from([JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n']);
 const output=new Writable({write(chunk,_enc,cb){outputText+=chunk;cb();}});
 const rpc=async(c,v)=>{if(c.name.endsWith('ensure')) return {}; methods.push(v.message.method); if(v.message.method==='initialize') return {status:200,messages:[{jsonrpc:'2.0',id:'cloud-init',result:{}}]}; if(v.message.method==='notifications/initialized') return {status:202,messages:[]}; return {status:200,messages:[{jsonrpc:'2.0',id:2,result:{tools:[{name:'example'}]}}]};};
 await mcp(env,rpc,input,output); assert.deepEqual(methods,['initialize','notifications/initialized','tools/list']); assert.equal(JSON.parse(outputText).result.tools[0].name,'example');
});

test('成功注册使用首条用户文本并写入环境文件',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-hook-test-')); try { const path=join(dir,'session.jsonl'), envFile=join(dir,'env'); await writeFile(path,rows.map(x=>JSON.stringify(x)).join('\n')); let input; const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_hook'+Date.now(),CLAUDE_ENV_FILE:envFile};
 const out=await hook({source:'startup',transcript_path:path},e,async(_c,v)=>{input=v;return {agentId:'agent-example',serverId:'server-example',epoch:'one',created:true};},false);
 assert.equal(input.title,rows.find(x=>x.type==='user' && typeof x.message?.content==='string' && !x.isMeta).message.content.slice(0,60));
 assert.match(await readFile(envFile,'utf8'),/export PASEO_AGENT_ID='agent-example'/); assert.match(out,/agent-example/); assert.ok(!out.includes(env.PASEO_MINI_HOST));
 } finally {await rm(dir,{recursive:true,force:true});}
});
