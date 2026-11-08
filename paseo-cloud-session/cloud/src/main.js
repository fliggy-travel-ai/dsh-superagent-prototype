import { createHostClient } from '@getpaseo/client/node';
import { ensureSession, pushTimeline, pollInbox, ackInbox, forwardMcp } from '../../../paseo-github-subscriptions/shared/cloud-session.ts';
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir, appendFile, open, stat, unlink } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const instructions = '请用 run_in_background 运行 node /opt/paseo-cloud-session/paseo-cloud-session.mjs wait；被唤醒后处理消息，处理完再启动下一次 wait。经 Paseo 工具创建子会话时必须传 settings.modeId。';
const redact = (value, env) => env.PASEO_MINI_HOST ? value.replaceAll(env.PASEO_MINI_HOST, '[已隐藏]') : value;
const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const eligible = env => !!env.PASEO_MINI_HOST && !!env.CLAUDE_CODE_REMOTE_SESSION_ID && !env.PASEO_AGENT_ID;
const sessionDir = env => join(tmpdir(), 'paseo-cloud-session-' + createHash('sha256').update(env.CLAUDE_CODE_REMOTE_SESSION_ID).digest('hex'));
const inputText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text || '').join('') : '';
async function titleFor(path) {
  try { for (const line of (await readFile(path, 'utf8')).split('\n')) { try { const x = JSON.parse(line); if (x.type === 'user' && !x.isMeta && !x.isSidechain) { const s = inputText(x.message?.content).trim(); if (s) return Array.from(s).slice(0,60).join(''); } } catch {} } } catch {}
  return '云端会话';
}
export function createRpc(env = process.env) {
  return async (contract, input) => {
    const client = createHostClient(env.PASEO_MINI_HOST, { clientId: 'cloud-session', connectTimeoutMs: 5000, logger: {debug(){},info(){},warn(){},error(){}} });
    try { await client.connect(); const result = await client.invokePluginRpc('github-subscriptions', contract.name, contract.input.parse(input)); return contract.output.parse(result); }
    finally { await client.close().catch(() => {}); }
  };
}
const context = env => ({cloudSessionId: env.CLAUDE_CODE_REMOTE_SESSION_ID});
async function ensure(rpc, env, path, cwd = process.cwd()) { return rpc(ensureSession, {...context(env), title: await titleFor(path), cwd}); }
export function mapper() {
  const calls = new Map(), texts = new Map(), thoughts = new Map();
  return row => {
    const items = []; let startTurn = false, endTurn;
    if (!row || row.isMeta || row.isSidechain) return null;
    const msg = row.message || {};
    if (row.type === 'user') {
      if (typeof msg.content === 'string' && msg.content.trim()) { startTurn = true; items.push({type:'user_message', id:row.uuid, text:msg.content}); }
      if (Array.isArray(msg.content)) for (const b of msg.content) if (b.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const prev = calls.get(b.tool_use_id), output = inputText(b.content), detail = {...prev.detail};
        if (detail.type === 'shell') detail.output = output;
        else if (detail.type === 'read' || detail.type === 'search') detail.content = output;
        else if (detail.type === 'unknown') detail.output = b.content ?? null;
        items.push({...prev, detail, status:b.is_error ? 'failed' : 'completed', error:b.is_error ? output : null});
      }
    } else if (row.type === 'assistant') {
      const id = msg.id || row.uuid;
      for (const b of msg.content || []) {
        if (b.type === 'text' && b.text) { const text = (texts.get(id) || '') + b.text; texts.set(id,text); items.push({type:'assistant_message',id,messageId:id,text}); }
        if (b.type === 'thinking' && b.thinking) { const text = (thoughts.get(id) || '') + b.thinking; thoughts.set(id,text); items.push({type:'reasoning',id:id+'-thinking',text}); }
        if (b.type === 'tool_use') {
          const v = b.input || {}; let detail;
          switch (b.name) {
            case 'Bash': detail={type:'shell',command:v.command || ''}; break;
            case 'Read': detail={type:'read',filePath:v.file_path || ''}; break;
            case 'Write': detail={type:'write',filePath:v.file_path || '',content:v.content || ''}; break;
            case 'Edit': detail={type:'edit',filePath:v.file_path || '',oldString:v.old_string || '',newString:v.new_string || ''}; break;
            case 'Grep': case 'Glob': detail={type:'search',query:v.pattern || '',toolName:b.name.toLowerCase()}; break;
            default: detail={type:'unknown',input:v,output:null};
          }
          const item={type:'tool_call',id:b.id,callId:b.id,name:b.name,detail,status:'running',error:null}; calls.set(b.id,item); items.push(item);
        }
      }
      if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') endTurn='completed';
    }
    return items.length || startTurn || endTurn ? {startTurn,items,...(endTurn && {endTurn})} : null;
  };
}
export class ForwardQueue {
  constructor(rpc, env) { this.rpc=rpc; this.env=env; this.pending=[]; this.map=mapper(); }
  add(row) { const value=this.map(row); if(value) this.pending.push(value); }
  async flush() { while(this.pending.length) { const value=this.pending[0]; const result=await this.rpc(pushTimeline,{...context(this.env),...value}); if(result.accepted !== value.items.length) throw Error('timeline rejected'); this.pending.shift(); } }
}
async function lock(dir) {
  await mkdir(dir,{recursive:true}); const p=join(dir,'forward.pid');
  for (let i=0;i<2;i++) { try { const f=await open(p,'wx'); await f.writeFile(String(process.pid)); await f.close(); return p; } catch(e) { if(e.code!=='EEXIST') throw e; const pid=Number(await readFile(p,'utf8').catch(()=>'')); if(!pid) return null; try { if(pid>0) { process.kill(pid,0); return null; } } catch(e) { if(e.code !== 'ESRCH') return null; } await unlink(p).catch(()=>{}); } } return null;
}
export async function forward(path, env=process.env, rpc=createRpc(env), startOffset) {
  const pid=await lock(sessionDir(env)); if(!pid) return;
  const queue=new ForwardQueue(rpc,env); let offset=startOffset ?? (await stat(path)).size, partial=Buffer.alloc(0), delay=500, registered=false;
  try { for (;;) {
    try {
      const f=await open(path,'r'); try { const size=(await f.stat()).size; if(size<offset) {offset=0;partial=Buffer.alloc(0);} if(size>offset) {const b=Buffer.alloc(size-offset); const {bytesRead}=await f.read(b,0,b.length,offset); offset+=bytesRead; partial=Buffer.concat([partial,b.subarray(0,bytesRead)]); let at; while((at=partial.indexOf(10))>=0) { const line=partial.subarray(0,at).toString(); partial=partial.subarray(at+1); try {queue.add(JSON.parse(line));} catch {} } } } finally {await f.close();}
      if(!registered || queue.pending.length) {await ensure(rpc,env,path); registered=true; await queue.flush();} delay=500;
    } catch { registered=false; delay=Math.min(delay*2,10000); }
    await sleep(delay);
  } } finally { await unlink(pid).catch(()=>{}); }
}
export async function hook(input, env=process.env, rpc=createRpc(env), launch=true) {
  if(!eligible(env) || (input.source === 'subagent' || input.agent_id || input.agent_type) || !input.transcript_path) return '';
  if(launch) { const size=await stat(input.transcript_path).then(x=>x.size).catch(()=>0); const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'forward',input.transcript_path,String(size)],{detached:true,stdio:'ignore',env}); child.unref(); }
  try { const result=await ensure(rpc,env,input.transcript_path,input.cwd || process.cwd());
    await mkdir(sessionDir(env),{recursive:true}); await writeFile(join(sessionDir(env),'epoch'),result.epoch,{flag:'wx'}).catch(()=>{});
    if(env.CLAUDE_ENV_FILE) await appendFile(env.CLAUDE_ENV_FILE,`export PASEO_AGENT_ID=${shellQuote(result.agentId)}\nexport PASEO_AGENT_SERVER_ID=${shellQuote(result.serverId)}\n`);
    return redact(`Paseo agent: ${result.agentId}\n${instructions}\n`, env);
  } catch { return 'Mac Mini 不可达或注册失败，Paseo 接入将在后台重试。\n'; }
}
export async function install(home, artifact, run = execFileSync) {
  const dir=join(home,'.claude'), path=join(dir,'settings.json'); await mkdir(dir,{recursive:true});
  let settings={}; try {settings=JSON.parse(await readFile(path,'utf8'));} catch(e) {if(e.code!=='ENOENT') throw e;}
  settings.hooks ||= {}; settings.hooks.SessionStart ||= [];
  const command=`node ${shellQuote(artifact)} hook-session-start`;
  if(!settings.hooks.SessionStart.some(x => x.hooks?.some(h=>h.type==='command' && h.command===command))) settings.hooks.SessionStart.push({hooks:[{type:'command',command}]});
  await writeFile(path,JSON.stringify(settings,null,2)+'\n');
  let exists=false; try {run('claude',['mcp','get','paseo'],{stdio:'ignore'}); exists=true;} catch {}
  if(!exists) run('claude',['mcp','add','--scope','user','paseo','--','node',artifact,'mcp'],{stdio:'ignore'});
}
export async function wait(env=process.env,rpc=createRpc(env), opts={}) {
  const dir=sessionDir(env), epochPath=join(dir,'epoch'); await mkdir(dir,{recursive:true}); let epoch=await readFile(epochPath,'utf8').catch(()=>null), delay=500, pending=null;
  for (;;) { try {
    if(!pending) { await ensure(rpc,env,opts.transcript || ''); const result=await rpc(pollInbox,{...context(env),afterSeq:0,waitMs:20000});
      if(epoch && epoch!==result.epoch) (opts.print || console.log)('Mac 上的插件重启过，之前没取走的消息已丢失');
      epoch=result.epoch; await writeFile(epochPath,epoch); if(!result.items.length) continue;
      for(const item of result.items) (opts.print || console.log)(redact(`seq: ${item.seq} delivery: ${item.delivery}\n${item.text}`,env));
      pending=result.items.at(-1).seq;
    }
    await rpc(ackInbox,{...context(env),seq:pending}); return;
  } catch { await (opts.sleep || sleep)(delay); delay=Math.min(delay*2,10000); } }
}
export async function mcp(env=process.env,rpc=createRpc(env), input=process.stdin, output=process.stdout) {
  const send = x => output.write(redact(JSON.stringify(x),env)+'\n');
  let remoteInitialized = false;
  for await (const line of readline.createInterface({input,crlfDelay:Infinity})) {
    let m; try {m=JSON.parse(line);} catch {continue;}
    if(m.method==='initialize') {send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params?.protocolVersion || '2025-03-26',capabilities:{tools:{}},serverInfo:{name:'paseo',version:'0.1.0'},instructions}}); continue;}
    if(m.id===undefined) continue;
    try { if(!env.PASEO_MINI_HOST || !env.CLAUDE_CODE_REMOTE_SESSION_ID) throw Error('not configured'); await ensure(rpc,env,''); if(!remoteInitialized) { const init=await rpc(forwardMcp,{...context(env),message:{jsonrpc:'2.0',id:'cloud-init',method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'paseo-cloud-session',version:'0.1.0'}}}}); if(init.status >= 400 || !init.messages.some(x=>x.id==='cloud-init' && x.result)) throw Error('initialization failed'); await rpc(forwardMcp,{...context(env),message:{jsonrpc:'2.0',method:'notifications/initialized'}}); remoteInitialized=true; } const result=await rpc(forwardMcp,{...context(env),message:m}); const response=result.messages.find(x=>x.id===m.id); if(!response) throw Error('missing response'); send(response); }
    catch { remoteInitialized=false; send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Paseo 不可达或工具调用失败，请稍后重试。'}}); }
  }
}
async function main() {
  const [cmd,arg]=process.argv.slice(2), env=process.env;
  if(cmd==='install-claude-config') return install(env.HOME,resolve(fileURLToPath(import.meta.url)));
  if(cmd==='hook-session-start') {let s=''; for await(const c of process.stdin) s+=c; let input; try {input=JSON.parse(s);} catch {return;} process.stdout.write(await hook(input,env)); return;}
  if(cmd==='mcp') return mcp(env);
  if(cmd==='forward' && eligible(env) && arg) return forward(arg,env,createRpc(env),process.argv[4] === undefined ? undefined : Number(process.argv[4]));
  if(cmd==='wait' && env.PASEO_MINI_HOST && env.CLAUDE_CODE_REMOTE_SESSION_ID) return wait(env);
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{process.stderr.write('Paseo 云端程序执行失败。\n'); process.exitCode=1;});
