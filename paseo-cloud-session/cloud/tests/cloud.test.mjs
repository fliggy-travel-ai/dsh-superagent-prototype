import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Writable, PassThrough } from 'node:stream';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { ProviderEventSchema } from '../node_modules/@getpaseo/plugin/dist/server/provider.js';
import { mapper, ForwardQueue, hook, install, wait, mcp, createRpc, updateTitle, forward, permissionHook, notifyRequest } from '../dist/paseo-cloud-session.mjs';
const env={PASEO_MINI_HOST:'https://app.paseo.sh/#offer=FAKE-SECRET',CLAUDE_CODE_REMOTE_SESSION_ID:'cse_test12345678'};
const rows=(await readFile(new URL('../../fixtures/transcript-sample.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
test('样例映射两轮、文本和工具结果',()=>{
 const map=mapper(), batches=rows.map(map).filter(Boolean), items=batches.flatMap(x=>x.items);
 for (const item of items) ProviderEventSchema.parse({type:'timeline.item',sessionId:'test',item});
 assert.equal(batches.filter(x=>x.startTurn).length,4); assert.equal(batches.filter(x=>x.endTurn==='completed').length,2); assert.equal(batches.filter(x=>x.endTurn==='canceled').length,2);
 assert.equal(items.filter(x=>x.type==='user_message').length,4); assert.ok(items.some(x=>x.type==='reasoning' && x.text));
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
 const home=await mkdtemp(join(tmpdir(),'paseo-install-test-')); try {await mkdir(join(home,'.claude')); await writeFile(join(home,'.claude/settings.json'),JSON.stringify({other:7,hooks:{SessionStart:[{hooks:[{type:'command',command:'existing'}]}],PermissionRequest:[{hooks:[{type:'command',command:'existing-permission'}]}]}})); let added=0;
 const run=(_cmd,args)=>{if(args[1]==='get' && !added) throw Error(); if(args[1]==='add') added++;};
 await install(home,'/opt/example.mjs',run); await install(home,'/opt/example.mjs',run);
 const settings=JSON.parse(await readFile(join(home,'.claude/settings.json'),'utf8')); assert.equal(settings.other,7); assert.equal(settings.hooks.SessionStart.length,2); assert.equal(settings.hooks.PermissionRequest.length,2); assert.equal(settings.hooks.PermissionRequest[0].hooks[0].command,'existing-permission'); assert.match(settings.hooks.PermissionRequest[1].hooks[0].command,/hook-permission-request/); assert.equal(added,1);
 } finally {await rm(home,{recursive:true,force:true});}
});
test('断线失败后恢复，按顺序补推未成功条目',async()=>{
 let fail=true; const accepted=[]; const rpc=async(_contract,value)=>{if(fail){fail=false;throw Error('offline');} accepted.push(value); return {accepted:value.items.length};};
 const q=new ForwardQueue(rpc,env); for(const row of rows) q.add(row); const count=q.pending.length; await assert.rejects(q.flush()); assert.equal(q.pending.length,count); await q.flush(); assert.equal(accepted.length,4); assert.equal(q.pending.length,0); assert.equal(accepted.filter(x=>x.startTurn).length,4); assert.deepEqual(accepted.map(x=>x.endTurn),['completed','completed','canceled','canceled']);
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
 const out=await hook({source:'startup',transcript_path:path},e,async(_c,v)=>{input=v;return {agentId:'agent-example',serverId:'server-example',workspaceId:'workspace-example',epoch:'one',created:true};},false);
 assert.equal(input.title,rows.find(x=>x.type==='user' && typeof x.message?.content==='string' && !x.isMeta).message.content.slice(0,60));
 const exported=await readFile(envFile,'utf8'); assert.match(exported,/export PASEO_AGENT_ID='agent-example'/); assert.match(exported,/export PASEO_WORKSPACE_ID='workspace-example'/); assert.match(out,/workspace-example/); assert.match(out,/rename_workspace/); assert.match(out,/agent-example/); assert.ok(!out.includes(env.PASEO_MINI_HOST));
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('thinking 和 text 均带 end_turn 时直到 stop_hook_summary 才结束，文本块提示与中断',()=>{
 const map=mapper(); const results=rows.map(row=>({row,result:map(row)}));
 const thinking=results.find(x=>x.row.uuid?.endsWith('000000000019'));
 const text=results.find(x=>x.row.uuid?.endsWith('000000000018'));
 assert.equal(thinking.result.endTurn,undefined); assert.equal(text.result.endTurn,undefined);
 assert.equal(results.find(x=>x.row.uuid?.endsWith('000000000020')).result.endTurn,'completed');
 assert.equal(results.find(x=>x.row.uuid?.endsWith('000000000021')).result.items[0].text,'请继续检查。');
 assert.equal(results.find(x=>x.row.uuid?.endsWith('000000000023')).result.endTurn,'canceled');
 assert.equal(results.find(x=>x.row.uuid?.endsWith('000000000025')).result.endTurn,'canceled');
 assert.equal(map({type:'system',subtype:'stop_hook_summary'}),null);
});

test('真实客户端不可达时钩子进程退出 0 且 MCP 报错',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-offline-')); const path=join(dir,'transcript'); await writeFile(path,'');
 const session='cse_offline'+Date.now(); const e={...process.env,PASEO_MINI_HOST:'ws://127.0.0.1:1',CLAUDE_CODE_REMOTE_SESSION_ID:session,PASEO_AGENT_ID:''};
 const rpc=createRpc(e); const begin=Date.now();
 try {
  const response=await hook({source:'startup',transcript_path:path},e,rpc,false); assert.ok(Date.now()-begin<12000); assert.equal(response.trim().split('\n').length,1); assert.match(response,/失败/); assert.ok(!response.includes(e.PASEO_MINI_HOST));
  let out=''; const input=Readable.from([JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n']); const output=new Writable({write(c,_e,cb){out+=c;cb();}});
  await mcp(e,rpc,input,output); assert.match(JSON.parse(out).error.message,/失败/); assert.ok(!out.includes(e.PASEO_MINI_HOST));
  const child=spawn(process.execPath,['dist/paseo-cloud-session.mjs','hook-session-start'],{env:e,stdio:['pipe','pipe','pipe']}); let stdout='',stderr=''; child.stdout.on('data',c=>stdout+=c); child.stderr.on('data',c=>stderr+=c); child.stdin.end(JSON.stringify({source:'startup',transcript_path:path}));
  const exit=await Promise.race([new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);}),new Promise((_,reject)=>setTimeout(()=>{child.kill();reject(Error('hook timed out'));},12000).unref())]);
  assert.equal(exit,0); assert.equal(stdout.trim().split('\n').length,1); assert.match(stdout,/失败/); assert.ok(!`${stdout}${stderr}`.includes(e.PASEO_MINI_HOST));
 } finally {await rpc.close(); const lock=join(tmpdir(),'paseo-cloud-session-'+createHash('sha256').update(session).digest('hex'),'forward.pid'); try {await waitFor(async()=>{try {return !!JSON.parse(await readFile(lock,'utf8')).pid;} catch {return false;}}); const pid=JSON.parse(await readFile(lock,'utf8')).pid; process.kill(pid,'SIGTERM');} catch {} await rm(dir,{recursive:true,force:true});}
});

test('客户端复用连接，断开后重建，超时会关闭',async()=>{
 let created=0,closed=0; const clients=[];
 const createClient=(_host,config)=>{assert.equal(config.reconnect.enabled,false); created++; const c={isConnected:false,async connect(){this.isConnected=true;},async close(){closed++;this.isConnected=false;},async invokePluginRpc(){return {agentId:'a',serverId:'s',epoch:'e',created:false};}}; clients.push(c); return c;};
 const contract={name:'cloud-session.ensure',input:{parse:x=>x},output:{parse:x=>x}}; const rpc=createRpc(env,{createClient,timeoutMs:200});
 await rpc(contract,{}); await rpc(contract,{}); assert.equal(created,1); clients[0].isConnected=false; await rpc(contract,{}); assert.equal(created,2); await rpc.close(); assert.equal(closed,2);
 let timeoutClosed=0; const slow=createRpc(env,{timeoutMs:20,createClient:()=>({isConnected:false,connect:()=>new Promise(()=>{}),close:async()=>{timeoutClosed++;}})});
 await assert.rejects(slow(contract,{}),/连接超时/); assert.equal(timeoutClosed,1);
});

test('批次限制 200 条，轮次边界和重试顺序',async()=>{
 const pushed=[]; let attempt=0; const rpc=async(_c,v)=>{if(++attempt===2) throw Error('offline'); pushed.push(v); return {accepted:v.items.length,epoch:'e'};};
 const q=new ForwardQueue(rpc,env); q.enqueue({startTurn:true,items:Array.from({length:250},(_,i)=>({type:'assistant_message',id:String(i),text:String(i)})),endTurn:'completed'});
 await assert.rejects(q.flush()); assert.equal(pushed.length,1); assert.equal(pushed[0].items.length,200); await q.flush(); assert.equal(pushed[1].items.length,50); assert.equal(pushed[1].endTurn,'completed'); assert.equal(pushed[1].startTurn,false);
});

test('第一条用户消息更新标题，工具参数和长度正确',async()=>{
 const messages=[]; const rpc=async(_c,v)=>{messages.push(v.message); if(v.message.method==='initialize') return {status:200,messages:[{id:'cloud-init',result:{}}]}; if(v.message.method==='tools/call') return {status:200,messages:[{id:'cloud-title',result:{}}]}; return {status:202,messages:[]};};
 await updateTitle(rpc,env,'agent-test','题'.repeat(65)); const call=messages.find(x=>x.method==='tools/call'); assert.equal(call.params.name,'update_agent'); assert.equal(call.params.arguments.agentId,'agent-test'); assert.equal(call.params.arguments.name.length,60);
});

test('工具列表失败后恢复发送一次 list_changed',async()=>{
 const input=new PassThrough(); let outputText='', online=false; const output=new Writable({write(c,_e,cb){outputText+=c;cb();}});
 const rpc=async(c,v)=>{if(!online) throw Error('offline'); if(c.name.endsWith('ensure')) return {}; if(v.message.method==='initialize') return {status:200,messages:[{id:'cloud-init',result:{}}]}; if(v.message.method==='notifications/initialized') return {status:202,messages:[]}; return {status:200,messages:[{id:v.message.id,result:{tools:[]}}]};};
 const task=mcp(env,rpc,input,output); input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n'); input.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})+'\n');
 await new Promise(r=>setTimeout(r,100)); online=true; await new Promise(r=>setTimeout(r,2300)); input.end(); await task;
 const responses=outputText.trim().split('\n').map(JSON.parse); assert.equal(responses[0].result.capabilities.tools.listChanged,true); assert.ok(responses[1].error); assert.equal(responses.filter(x=>x.method==='notifications/tools/list_changed').length,1);
});

const waitFor=async fn=>{for(let i=0;i<140;i++){if(await fn()) return; await new Promise(r=>setTimeout(r,50));} throw Error('condition timed out');};
test('forward 第一条提示只改名一次，/clear 换文件时旧转发退出并由新转发接管',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-forward-test-')); const first=join(dir,'first'),second=join(dir,'second'); await writeFile(first,''); await writeFile(second,'');
 const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_fwd'+Date.now()}; const lock=join(tmpdir(),'paseo-cloud-session-'+createHash('sha256').update(e.CLAUDE_CODE_REMOTE_SESSION_ID).digest('hex'),'forward.pid');
 const calls=[]; let titles=0, ensures=0; const rpc=async(c,v)=>{calls.push({name:c.name,value:v}); if(c.name.endsWith('ensure')) {ensures++; return {agentId:'agent',epoch:'e'};} if(c.name.endsWith('timeline.push')) return {accepted:v.items.length,epoch:'e'}; if(c.name.endsWith('mcp')) {if(v.message.method==='initialize') return {status:200,messages:[{id:'cloud-init',result:{}}]}; if(v.message.method==='tools/call') {titles++; return {status:200,messages:[{id:'cloud-title',result:{}}]};} return {status:202,messages:[]};}};
 const old=forward(first,e,rpc,0); let next;
 try {await waitFor(async()=>{try{return JSON.parse(await readFile(lock,'utf8')).path===first;}catch{return false;}});
 await writeFile(first,JSON.stringify({type:'user',uuid:'first',message:{content:'第一条标题'}})+'\n'); await waitFor(()=>titles===1);
 await writeFile(first,JSON.stringify({type:'user',uuid:'second',message:{content:'不要重复改名'}})+'\n',{flag:'a'}); await waitFor(()=>calls.filter(x=>x.name.endsWith('timeline.push')).length>=2); assert.equal(titles,1); assert.equal(ensures,1);
 next=forward(second,e,rpc,0); await waitFor(async()=>{try{return JSON.parse(await readFile(lock,'utf8')).path===second;}catch{return false;}}); await old;
 await writeFile(second,JSON.stringify({type:'user',uuid:'third',message:{content:'清空后的消息'}})+'\n'); await waitFor(()=>calls.some(x=>x.value.items?.some(y=>y.id==='third'))); assert.equal(titles,1);
 } finally {try {await writeFile(lock,JSON.stringify({pid:process.pid,path:'finished',token:'finished'}));} catch {} if(next) await next; await old; await rm(dir,{recursive:true,force:true});}
});

test('钩子输出保留可读错误并隐藏链接和令牌',async()=>{
 for(const [err,expected] of [['配对链接无效','配对链接无效'],['Plugin method missing: cloud-session.ensure','Plugin method missing'],['连接超时','连接超时'],['连接 wss://example.invalid/path?secret=FAKE-URL ws://example.invalid/socket 失败','连接'],['Paseo error token=FAKE-TOKEN Bearer FAKE-BEARER '+env.PASEO_MINI_HOST,'Paseo error']]) {
  const out=await hook({transcript_path:'missing'},env,async()=>{throw Error(err)},false); assert.match(out,new RegExp(expected)); assert.ok(!out.includes('FAKE-TOKEN')); assert.ok(!out.includes('FAKE-BEARER')); assert.ok(!out.includes('example.invalid')); assert.ok(!out.includes('FAKE-URL')); assert.ok(!out.includes(env.PASEO_MINI_HOST)); assert.equal(out.trim().split('\n').length,1);
 }
});

test('启动片段限制下载时间且安装失败返回 0 和警告',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-setup-test-')); try {const bin=join(dir,'bin'); await mkdir(bin);
 const scripts={curl:'printf "%s\\n" "$*" > "$TEST_LOG"; while [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf data > "$1"; break; fi; shift; done',sha256sum:'echo "SHA256_PLACEHOLDER  file"',install:'exit 0',mkdir:'exit 0',node:'exit 1'};
 for(const [name,body] of Object.entries(scripts)) await writeFile(join(bin,name),'#!/bin/sh\n'+body+'\n',{mode:0o755});
 const {stderr}=await promisify(execFile)('/bin/bash',['setup-snippet.sh'],{env:{...process.env,PATH:bin+':/usr/bin:/bin',TEST_LOG:join(dir,'curl.log')}});
 assert.match(stderr,/警告：Claude 配置安装失败/); const args=await readFile(join(dir,'curl.log'),'utf8'); assert.match(args,/--max-time 60/); assert.match(args,/--retry 2/);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('forward 在 not_opened 与 epoch 变化后重新确保注册',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-epoch-test-')), path=join(dir,'transcript'); await writeFile(path,'');
 const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_epoch'+Date.now()}; const lock=join(tmpdir(),'paseo-cloud-session-'+createHash('sha256').update(e.CLAUDE_CODE_REMOTE_SESSION_ID).digest('hex'),'forward.pid');
 let ensureCount=0,pushCount=0; const rpc=async(c,v)=>{if(c.name.endsWith('ensure')) return {agentId:'a',epoch:++ensureCount===1?'one':'two'}; if(c.name.endsWith('timeline.push')) {pushCount++; if(pushCount===1) throw Error('not_opened'); return {accepted:v.items.length,epoch:pushCount===2?'two':'three'};} if(v.message?.method==='initialize') return {status:200,messages:[{id:'cloud-init',result:{}}]}; if(v.message?.method==='tools/call') return {status:200,messages:[{id:'cloud-title',result:{}}]}; return {status:202,messages:[]};};
 const task=forward(path,e,rpc,0);
 try {await waitFor(()=>ensureCount===1); await writeFile(path,JSON.stringify({type:'user',uuid:'a',message:{content:'提示'}})+'\n'); await waitFor(()=>pushCount>=2 && ensureCount>=2); await writeFile(path,JSON.stringify({type:'system',subtype:'stop_hook_summary'})+'\n',{flag:'a'}); await waitFor(()=>pushCount>=3 && ensureCount>=3); assert.equal(ensureCount,3);}
 finally {await writeFile(lock,JSON.stringify({pid:process.pid,path:'finished',token:'finished'})); await task; await rm(dir,{recursive:true,force:true});}
});

test('wait 在继承 PASEO_AGENT_ID 时仍取消息',async()=>{
 let ack=false; const e={...env,PASEO_AGENT_ID:'parent',CLAUDE_CODE_REMOTE_SESSION_ID:'cse_waitagent'+Date.now()};
 const rpc=async(c)=>{if(c.name.endsWith('ensure')) return {}; if(c.name.endsWith('poll')) return {epoch:'e',items:[{seq:1,delivery:'auto',text:'hello'}]}; ack=true; return {};};
 const lines=[]; await wait(e,rpc,{print:s=>lines.push(s)}); assert.equal(ack,true); assert.match(lines.join(''),/hello/);
});

test('标题失败最多三次、复用同一 MCP 初始化且接管后不覆盖名称',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-title-test-')); const first=join(dir,'first'),second=join(dir,'second'),third=join(dir,'third');
 for(const path of [first,second,third]) await writeFile(path,'');
 const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_title'+Date.now()}; const lock=join(tmpdir(),'paseo-cloud-session-'+createHash('sha256').update(e.CLAUDE_CODE_REMOTE_SESSION_ID).digest('hex'),'forward.pid');
 const methods=[], times=[]; let pushed=0; const rpc=async(c,v)=>{
  if(c.name.endsWith('ensure')) return {agentId:'agent',epoch:'e'};
  if(c.name.endsWith('timeline.push')) {pushed++; return {accepted:v.items.length,epoch:'e'};}
  methods.push(v.message.method);
  if(v.message.method==='initialize') return {status:200,messages:[{id:'cloud-init',result:{}}]};
  if(v.message.method==='notifications/initialized') return {status:202,messages:[]};
  times.push(Date.now()); return {status:200,messages:[{id:'cloud-title',error:{message:'拒绝 wss://example.invalid/secret'}}]};
 };
 const firstTask=forward(first,e,rpc,0); let secondTask,thirdTask;
 try {
  await waitFor(async()=>{try{return JSON.parse(await readFile(lock,'utf8')).path===first;}catch{return false;}});
  await writeFile(first,JSON.stringify({type:'user',uuid:'one',message:{content:'初始标题'}})+'\n');
  await waitFor(async()=>{try{return !!JSON.parse(await readFile(lock,'utf8')).titleError;}catch{return false;}});
  assert.equal(times.length,3); assert.ok(times[1]-times[0]>=900); assert.ok(times[2]-times[1]>=1900);
  assert.equal(methods.filter(x=>x==='initialize').length,1); assert.equal(methods.filter(x=>x==='notifications/initialized').length,1);
  const record=JSON.parse(await readFile(lock,'utf8')); assert.equal(record.titleHandled,true); assert.match(record.titleError,/拒绝/); assert.ok(!record.titleError.includes('example.invalid'));
  await new Promise(r=>setTimeout(r,1200)); assert.equal(times.length,3);
  secondTask=forward(second,e,rpc,0); await waitFor(async()=>{try{return JSON.parse(await readFile(lock,'utf8')).path===second;}catch{return false;}}); await firstTask;
  await writeFile(second,JSON.stringify({type:'user',uuid:'two',message:{content:'会话已自行改名'}})+'\n'); await waitFor(()=>pushed>=2); assert.equal(times.length,3);
  const stale=JSON.parse(await readFile(lock,'utf8')); stale.pid=0; await writeFile(lock,JSON.stringify(stale));
  thirdTask=forward(third,e,rpc,0); await waitFor(async()=>{try{return JSON.parse(await readFile(lock,'utf8')).path===third;}catch{return false;}}); await secondTask;
  await writeFile(third,JSON.stringify({type:'user',uuid:'three',message:{content:'重启后新消息'}})+'\n'); await waitFor(()=>pushed>=3); assert.equal(times.length,3);
 } finally {try {await writeFile(lock,JSON.stringify({pid:process.pid,path:'finished',token:'finished'}));} catch {} if(thirdTask) await thirdTask; if(secondTask) await secondTask; await firstTask; await rm(dir,{recursive:true,force:true});}
});

test('ensure 在配置和未配置备用目录时传入正确字段',async()=>{
 const seen=[]; const rpc=async(_contract,input)=>{seen.push(input); return {agentId:'agent',serverId:'server',epoch:'epoch',created:true};};
 const base={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_fallback'+Date.now()};
 await hook({source:'startup',transcript_path:'missing',cwd:'/cloud/work/project'}, {...base,PASEO_CLOUD_SESSION_FALLBACK_CWD:'/mac/fallback'},rpc,false);
 await hook({source:'startup',transcript_path:'missing'}, {...base,PASEO_CLOUD_SESSION_FALLBACK_CWD:''},rpc,false);
 assert.equal(seen[0].cwd,'/cloud/work/project'); assert.equal(seen[0].fallbackCwd,'/mac/fallback');
 assert.equal(seen[1].cwd,process.cwd()); assert.equal(Object.hasOwn(seen[1],'fallbackCwd'),false);
});

test('MCP 初始化说明含工作区编号和阶段改名要求',async()=>{
 const input=Readable.from([JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n']); let outputText=''; const output=new Writable({write(c,_e,cb){outputText+=c;cb();}});
 await mcp({...env,PASEO_WORKSPACE_ID:'workspace-example'},async()=>{},input,output);
 const text=JSON.parse(outputText).result.instructions; assert.match(text,/workspace-example/); assert.match(text,/rename_workspace/); assert.match(text,/需求阶段变化/);
});

test('权限钩子立即返回并由分离后台进程通知，工具 ID 从记录查找',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-notify-test-')), file=join(dir,'log'), transcript=join(dir,'transcript'), worker=join(dir,'worker.mjs');
 const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_notify'+Date.now(),TEST_OUTPUT:file};
 await writeFile(transcript,[{type:'assistant',message:{content:[{type:'tool_use',name:'AskUserQuestion',id:'old-id',input:{}}]}},{type:'assistant',message:{content:[{type:'tool_use',name:'AskUserQuestion',id:'new-id',input:{questions:[{question:'问题？'}]}}]}}].map(JSON.stringify).join('\n')+'\n');
 const bundle=pathToFileURL(join(process.cwd(),'dist/paseo-cloud-session.mjs')).href;
 await writeFile(worker,`import {notifyRequest} from ${JSON.stringify(bundle)}; import {writeFile} from 'node:fs/promises'; let data=''; for await(const c of process.stdin) data+=c; await new Promise(r=>setTimeout(r,1200)); await notifyRequest(JSON.parse(data),process.env,async(c,v)=>{await writeFile(process.env.TEST_OUTPUT,JSON.stringify({method:c.name,input:v})); return {shown:true};});`);
 const input={hook_event_name:'PermissionRequest',session_id:'example',transcript_path:transcript,tool_name:'AskUserQuestion',tool_input:{questions:[{question:'问题？'}]}};
 try {const start=Date.now(); permissionHook(input,e,(_exe,_args,opts)=>spawn(process.execPath,[worker],opts)); assert.ok(Date.now()-start<1000); await waitFor(async()=>{try{await statFile(file); return true;}catch{return false;}}); const record=JSON.parse(await readFile(file,'utf8')); assert.equal(record.method,'cloud-session.request.notify'); assert.equal(record.input.request.toolUseId,'new-id'); assert.equal(record.input.request.kind,'question'); assert.deepEqual(record.input.request.input,input.tool_input);}
 finally {await rm(dir,{recursive:true,force:true});}
});
const statFile=async path=>readFile(path);

test('权限钩子不可达时进程立即退出且无输出与决定',async()=>{
 const e={...process.env,PASEO_MINI_HOST:'ws://127.0.0.1:1',CLAUDE_CODE_REMOTE_SESSION_ID:'cse_permission'+Date.now(),PASEO_AGENT_ID:''};
 const child=spawn(process.execPath,['dist/paseo-cloud-session.mjs','hook-permission-request'],{env:e,stdio:['pipe','pipe','pipe']}); let stdout='',stderr=''; child.stdout.on('data',x=>stdout+=x); child.stderr.on('data',x=>stderr+=x);
 const start=Date.now(); child.stdin.end(JSON.stringify({tool_name:'Read',tool_use_id:'example-id',tool_input:{file_path:'example'}}));
 const code=await Promise.race([new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);}),new Promise((_,reject)=>setTimeout(()=>{child.kill();reject(Error('permission hook timed out'));},2000).unref())]);
 assert.equal(code,0); assert.ok(Date.now()-start<1000); assert.equal(stdout,''); assert.ok(!stderr.includes(e.PASEO_MINI_HOST)); assert.ok(!stderr.includes('decision'));
});

test('工具结果在通知前后到达都能关闭已通知请求',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-resolve-test-')), path=join(dir,'transcript'); await writeFile(path,'');
 const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_resolve'+Date.now()}; const lock=join(tmpdir(),'paseo-cloud-session-'+createHash('sha256').update(e.CLAUDE_CODE_REMOTE_SESSION_ID).digest('hex'),'forward.pid');
 const seen=[]; const rpc=async(c,v)=>{if(c.name.endsWith('ensure')) return {agentId:'a',workspaceId:'w',epoch:'e'}; if(c.name.endsWith('timeline.push')) return {accepted:v.items.length,epoch:'e'}; if(c.name.endsWith('request.notify')) {seen.push({type:'notify',value:v}); return {shown:true};} if(c.name.endsWith('request.resolve')) {seen.push({type:'resolve',value:v}); return {closed:true};} throw Error('unexpected RPC');};
 const task=forward(path,e,rpc,0);
 try {await waitFor(async()=>{try{return JSON.parse(await readFile(lock,'utf8')).path===path;}catch{return false;}});
  const result=(id,content,isError=false,interrupted=false)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content,is_error:isError}]},toolUseResult:{interrupted}});
  await writeFile(path,[result('a','Permission denied: unable to open file',true),result('b','Permission denied by user',true),result('c','interrupted',true,true)].map(JSON.stringify).join('\n')+'\n');
  await new Promise(r=>setTimeout(r,700));
  for(const id of ['a','b','c']) await notifyRequest({tool_name:'Bash',tool_use_id:id,tool_input:{command:'example'}},e,rpc);
  await waitFor(()=>seen.filter(x=>x.type==='resolve').length===3); assert.ok(seen.filter(x=>x.type==='notify').every(x=>x.value.request.kind==='tool'));
  assert.deepEqual(seen.filter(x=>x.type==='resolve').map(x=>[x.value.toolUseId,x.value.outcome]),[['a','answered'],['b','denied'],['c','canceled']]);
 } finally {try {await writeFile(lock,JSON.stringify({pid:process.pid,path:'finished',token:'finished'}));} catch {} await task; await rm(dir,{recursive:true,force:true});}
});

test('权限钩子不为不符合注册条件的会话启动后台进程',()=>{
 let count=0; const launch=()=>{count++;throw Error('unexpected launch');}; const input={tool_name:'Read',tool_input:{file_path:'example'}};
 for(const e of [{...env,PASEO_MINI_HOST:''},{...env,CLAUDE_CODE_REMOTE_SESSION_ID:''},{...env,PASEO_AGENT_ID:'other'}]) permissionHook(input,e,launch);
 permissionHook({...input,agent_id:'subagent'},env,launch); assert.equal(count,0);
});

test('forward 在无时间线变化时发送周期联系',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'paseo-beat-test-')); const path=join(dir,'transcript'); await writeFile(path,'');
 const e={...env,CLAUDE_CODE_REMOTE_SESSION_ID:'cse_beat'+Date.now()}; const lock=join(tmpdir(),'paseo-cloud-session-'+createHash('sha256').update(e.CLAUDE_CODE_REMOTE_SESSION_ID).digest('hex'),'forward.pid');
 const beats=[]; const rpc=async(c,v)=>{if(c.name.endsWith('ensure')) return {agentId:'a',epoch:'e'}; if(c.name.endsWith('timeline.push')) {beats.push(v); return {accepted:v.items.length,epoch:'e'};} throw Error(c.name);};
 const task=forward(path,e,rpc,0,{remoteBeatMs:1});
 try {await waitFor(()=>beats.length>=1); assert.equal(beats[0].startTurn,false); assert.deepEqual(beats[0].items,[]);}
 finally {try {await writeFile(lock,JSON.stringify({pid:process.pid,path:'finished',token:'finished'}));} catch {} await task; await rm(dir,{recursive:true,force:true});}
});
