import { createHostClient } from '@getpaseo/client/node';
import { ensureSession, pushTimeline, pollInbox, ackInbox, forwardMcp, notifyPendingRequest, resolvePendingRequest } from '../../../paseo-github-subscriptions/shared/cloud-session.ts';
import { realpathSync } from 'node:fs';
import { readFile, writeFile, mkdir, appendFile, open, stat, unlink, rename } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const workspaceInstructions = id => `这个会话在 Paseo 里有自己的工作区 ${id || '（编号见 PASEO_WORKSPACE_ID）'}；定下需求 Issue 后以及每次需求阶段变化时，用 Paseo 工具 rename_workspace 将它改成 <Issue 号>【<状态>】<需求名>。`;
const instructions = '请用 run_in_background 运行 node /opt/paseo-cloud-session/paseo-cloud-session.mjs wait；被唤醒后处理消息，处理完再启动下一次 wait。经 Paseo 工具创建子会话时必须传 settings.modeId。';
const redact = (value, env) => env.PASEO_MINI_HOST ? value.replaceAll(env.PASEO_MINI_HOST, '[已隐藏]') : value;
const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const eligible = env => !!env.PASEO_MINI_HOST && !!env.CLAUDE_CODE_REMOTE_SESSION_ID && !env.PASEO_AGENT_ID;
const sessionDir = env => join(tmpdir(), 'paseo-cloud-session-' + createHash('sha256').update(env.CLAUDE_CODE_REMOTE_SESSION_ID).digest('hex'));
const inputText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text || '').join('') : '';
async function titleFor(path, endOffset) {
  try { for (const line of (await readFile(path)).subarray(0,endOffset).toString('utf8').split('\n')) { try { const x = JSON.parse(line); if (x.type === 'user' && !x.isMeta && !x.isSidechain) { const s = inputText(x.message?.content).trim(); if (s) return Array.from(s).slice(0,60).join(''); } } catch {} } } catch {}
  return '云端会话';
}
export function createRpc(env = process.env, options = {}) {
  let client, connecting;
  const timeoutMs = options.timeoutMs ?? 10000;
  const close = async () => { const old=client; client=undefined; if(old) await old.close().catch(()=>{}); };
  const connect = async () => {
    if(client?.isConnected) return client;
    if(connecting) return connecting;
    connecting=(async()=>{
      await close();
      let next;
      try { next=(options.createClient || createHostClient)(env.PASEO_MINI_HOST, {clientId:'cloud-session',connectTimeoutMs:timeoutMs,reconnect:{enabled:false},logger:{debug(){},info(){},warn(){},error(){}}}); }
      catch { throw Error('配对链接无效'); }
      client=next; let timer;
      try {
        await Promise.race([next.connect(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('连接超时')),timeoutMs);})]);
        return next;
      } catch(error) { await close(); throw error; } finally {clearTimeout(timer);}
    })();
    try {return await connecting;} finally {connecting=undefined;}
  };
  const rpc=async (contract, input) => {
    const active=await connect();
    try {const result=await active.invokePluginRpc('github-subscriptions',contract.name,contract.input.parse(input)); return contract.output.parse(result);}
    catch(error) {if(!active.isConnected) await close(); throw error;}
  };
  rpc.close=close;
  return rpc;
}
function safeReason(error, env) {
  let message=error instanceof Error ? error.message : String(error);
  const host=env.PASEO_MINI_HOST || '';
  if(host) { message=message.replaceAll(host,'[已隐藏]'); try {const u=new URL(host); for(const v of u.searchParams.values()) if(v) message=message.replaceAll(v,'[已隐藏]'); const frag=new URLSearchParams(u.hash.slice(1)); for(const v of frag.values()) if(v) message=message.replaceAll(v,'[已隐藏]');} catch {} }
  return message.replace(/Bearer\s+[^\s,;]+/gi,'Bearer [已隐藏]').replace(/((?:token|password|authorization|offer|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]').replace(/(?:https?|wss?):\/\/[^\s"']+/gi,'[地址已隐藏]').replace(/[\r\n]+/g,' ').trim().slice(0,500) || '未知错误';
}
const context = env => ({cloudSessionId: env.CLAUDE_CODE_REMOTE_SESSION_ID});
async function ensure(rpc, env, path, cwd = process.cwd()) { return rpc(ensureSession, {...context(env), title: await titleFor(path), cwd, ...(env.PASEO_CLOUD_SESSION_FALLBACK_CWD ? {fallbackCwd:env.PASEO_CLOUD_SESSION_FALLBACK_CWD} : {})}); }
export function mapper() {
  const calls = new Map(), texts = new Map(), thoughts = new Map(); let canceled=false;
  return row => {
    const items = []; let startTurn = false, endTurn;
    if (!row || row.isMeta || row.isSidechain) return null;
    const msg = row.message || {};
    if (row.type === 'user') {
      const text=inputText(msg.content);
      if(text.trim().startsWith('[Request interrupted by user')) {endTurn='canceled'; canceled=true;}
      else if(text.trim()) { canceled=false; startTurn=true; items.push({type:'user_message',id:row.uuid,text}); }
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
    } else if(row.type === 'system' && row.subtype === 'stop_hook_summary') {if(!canceled) endTurn='completed'; canceled=false;}
    return items.length || startTurn || endTurn ? {startTurn,items,...(endTurn && {endTurn})} : null;
  };
}
export class ForwardQueue {
  constructor(rpc, env) { this.rpc=rpc; this.env=env; this.pending=[]; this.map=mapper(); this.epoch=null; this.onEpochChange=null; }
  enqueue(value) { if(!value) return; if(value.items.length<=200) {this.pending.push(value); return;} for(let i=0;i<value.items.length;i+=200) this.pending.push({startTurn:i===0 && value.startTurn,items:value.items.slice(i,i+200),...(i+200>=value.items.length && value.endTurn ? {endTurn:value.endTurn} : {})}); }
  add(row) { this.enqueue(this.map(row)); }
  async flush() {
    while(this.pending.length) {
      const batch={startTurn:false,items:[]}; let count=0;
      for(const next of this.pending) {
        if(count && (next.startTurn || batch.endTurn || batch.items.length+next.items.length>200)) break;
        batch.startTurn ||= next.startTurn; batch.items.push(...next.items); if(next.endTurn) batch.endTurn=next.endTurn; count++;
        if(batch.endTurn) break;
      }
      const result=await this.rpc(pushTimeline,{...context(this.env),...batch});
      if(result.accepted !== batch.items.length) throw Error('timeline rejected');
      this.pending.splice(0,count);
      if(this.epoch && result.epoch && this.epoch!==result.epoch) await this.onEpochChange?.(result.epoch);
      if(result.epoch) this.epoch=result.epoch;
    }
  }
}
async function lock(dir, path) {
  await mkdir(dir,{recursive:true}); const file=join(dir,'forward.pid'); const token=randomUUID();
  const mine={pid:process.pid,path,token,titleHandled:false};
  for(let i=0;i<4;i++) {
    try {const f=await open(file,'wx'); await f.writeFile(JSON.stringify(mine)); await f.close(); return {file,token,titleHandled:mine.titleHandled};}
    catch(e) {if(e.code!=='EEXIST') throw e;}
    let existing; try {existing=JSON.parse(await readFile(file,'utf8'));} catch {await sleep(50); continue;}
    let alive=false; if(existing.pid>0) {try {process.kill(existing.pid,0); alive=true;} catch(e) {if(e.code!=='ESRCH') return null;}}
    if(alive && existing.path===path) return null;
    mine.titleHandled=!!existing.titleHandled; const tmp=join(dir,`forward-${token}.tmp`); await writeFile(tmp,JSON.stringify(mine)); await rename(tmp,file); return {file,token,titleHandled:mine.titleHandled};
  }
  return null;
}
async function updateLease(lease, changes) {
  const f=await open(lease.file,'r+'); try {const info=JSON.parse(await f.readFile('utf8')); if(info.token!==lease.token) return false; Object.assign(info,changes); const value=JSON.stringify(info); await f.write(value,0,'utf8'); await f.truncate(Buffer.byteLength(value)); return true;} finally {await f.close();}
}
async function ownsLock(lock) { try {return JSON.parse(await readFile(lock.file,'utf8')).token===lock.token;} catch {return false;} }
async function remoteInit(rpc, env) {
  const init=await rpc(forwardMcp,{...context(env),message:{jsonrpc:'2.0',id:'cloud-init',method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'paseo-cloud-session',version:'0.1.0'}}}});
  if(init.status>=400 || !init.messages.some(x=>x.id==='cloud-init' && x.result)) throw Error('Paseo MCP 初始化失败');
  await rpc(forwardMcp,{...context(env),message:{jsonrpc:'2.0',method:'notifications/initialized'}});
}
export async function updateTitle(rpc, env, agentId, title, state={attempted:false,initialized:false}) {
  if(!state.attempted) {state.attempted=true; await remoteInit(rpc,env); state.initialized=true;}
  if(!state.initialized) throw Error('Paseo MCP 初始化失败');
  const result=await rpc(forwardMcp,{...context(env),message:{jsonrpc:'2.0',id:'cloud-title',method:'tools/call',params:{name:'update_agent',arguments:{agentId,name:Array.from(title).slice(0,60).join('')}}}});
  const reply=result.messages.find(x=>x.id==='cloud-title');
  if(result.status>=400 || !reply || reply.error || reply.result?.isError) throw Error('Paseo 标题更新失败：'+(reply?.error?.message || reply?.result?.content?.map?.(x=>x.text || '').join(' ') || `HTTP ${result.status}`));
}
const requestMarker=(env,id)=>join(sessionDir(env),'requests',createHash('sha256').update(id).digest('hex'));
function resultOutcome(block,row) {
  const text=inputText(block.content);
  if(row.toolUseResult?.interrupted || /\[Request interrupted by user/i.test(text)) return 'canceled';
  if(block.is_error && /(?:user (?:denied|rejected)|permission (?:denied|rejected) by (?:the )?user|denied by (?:the )?user|tool use was rejected|user (?:does not|doesn't) want to proceed|用户拒绝)/i.test(text)) return 'denied';
  return 'answered';
}
export async function notifyRequest(input, env=process.env, rpc=createRpc(env)) {
  const toolName=input.tool_name, toolInput=input.tool_input;
  if(typeof toolName!=='string' || !toolName || !toolInput || typeof toolInput!=='object' || Array.isArray(toolInput)) return;
  let id=typeof input.tool_use_id==='string' ? input.tool_use_id : '';
  if(!id && input.transcript_path) {
    try {const lines=(await readFile(input.transcript_path,'utf8')).split('\n');
      for(let i=lines.length-1;i>=0 && !id;i--) {try {const row=JSON.parse(lines[i]); if(row.type!=='assistant' || row.isSidechain || row.isMeta) continue; const blocks=row.message?.content; if(!Array.isArray(blocks)) continue; for(let j=blocks.length-1;j>=0;j--) {const b=blocks[j]; if(b.type==='tool_use' && b.name===toolName && typeof b.id==='string' && b.id) {id=b.id;break;}}} catch {}}
    } catch {}
  }
  if(!id) return;
  await rpc(notifyPendingRequest,{...context(env),request:{toolUseId:id,toolName,kind:toolName==='AskUserQuestion'?'question':'tool',input:toolInput}});
  const marker=requestMarker(env,id); await mkdir(join(sessionDir(env),'requests'),{recursive:true}); await writeFile(marker,'');
}
export function permissionHook(input, env=process.env, launch=spawn) {
  if(!eligible(env) || input.agent_id || input.agent_type || input.source==='subagent') return;
  const child=launch(process.execPath,[fileURLToPath(import.meta.url),'permission-notify'],{detached:true,stdio:['pipe','ignore','ignore'],env,cwd:input.cwd || process.cwd()});
  child.on('error',()=>{}); child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(input)); child.unref();
}
export async function forward(path, env=process.env, rpc=createRpc(env), startOffset) {
  const lease=await lock(sessionDir(env),path); if(!lease) return;
  const queue=new ForwardQueue(rpc,env); const requestResults=new Map(); let offset=startOffset ?? (await stat(path)).size, partial=Buffer.alloc(0), delay=500, registered=false, agentId, titlePending=null;
  let titleHandled=lease.titleHandled || (await titleFor(path,offset))!=='云端会话';
  let titleAttempts=0, titleNext=0; const titleMcp={attempted:false,initialized:false};
  if(titleHandled && !lease.titleHandled && !await updateLease(lease,{titleHandled:true})) return;
  const register=async()=>{const result=await ensure(rpc,env,path); registered=true; agentId=result.agentId; queue.epoch=result.epoch;};
  queue.onEpochChange=async()=>{registered=false; await register();};
  try { for (;;) {
    if(!await ownsLock(lease)) return;
    try {
      const f=await open(path,'r'); try { const size=(await f.stat()).size; if(size<offset) {offset=0;partial=Buffer.alloc(0);} if(size>offset) {const b=Buffer.alloc(size-offset); const {bytesRead}=await f.read(b,0,b.length,offset); offset+=bytesRead; partial=Buffer.concat([partial,b.subarray(0,bytesRead)]); let at; while((at=partial.indexOf(10))>=0) { const line=partial.subarray(0,at).toString(); partial=partial.subarray(at+1); try {const row=JSON.parse(line); if(row.type==='user' && !row.isMeta && !row.isSidechain && Array.isArray(row.message?.content)) for(const block of row.message.content) if(block.type==='tool_result' && typeof block.tool_use_id==='string') requestResults.set(block.tool_use_id,resultOutcome(block,row)); const value=queue.map(row); if(value) {queue.enqueue(value); if(!titleHandled && !titlePending) titlePending=value.items.find(x=>x.type==='user_message')?.text || null;}} catch {} } } } finally {await f.close();}
      if(!registered) await register();
      await queue.flush();
      for(const [toolUseId,outcome] of requestResults) {const marker=requestMarker(env,toolUseId); try {await stat(marker);} catch(e) {if(e.code==='ENOENT') continue; throw e;} await rpc(resolvePendingRequest,{...context(env),toolUseId,outcome}); await unlink(marker).catch(()=>{}); requestResults.delete(toolUseId);}
      if(titlePending && Date.now()>=titleNext) {
        if(!titleHandled) {if(!await updateLease(lease,{titleHandled:true})) return; titleHandled=true;}
        titleAttempts++;
        try {await updateTitle(rpc,env,agentId,titlePending,titleMcp); titlePending=null;}
        catch(error) {if(String(error).includes('not_opened')) registered=false; if(titleAttempts>=3) {const reason=safeReason(error,env); await updateLease(lease,{titleError:reason}); process.stderr.write(`Paseo 标题更新失败，已放弃：${reason}\n`); titlePending=null;} else titleNext=Date.now()+1000*2**(titleAttempts-1);}
      }
      delay=500;
    } catch(error) { if(String(error).includes('not_opened')) registered=false; delay=Math.min(delay*2,10000); }
    await sleep(delay);
  } } finally { if(await ownsLock(lease)) {if(titleHandled) await updateLease(lease,{pid:0}).catch(()=>{}); else await unlink(lease.file).catch(()=>{});} }
}
export async function hook(input, env=process.env, rpc=createRpc(env), launch=true) {
  if(!eligible(env) || (input.source === 'subagent' || input.agent_id || input.agent_type) || !input.transcript_path) return '';
  if(launch) { const size=await stat(input.transcript_path).then(x=>x.size).catch(()=>0); const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'forward',input.transcript_path,String(size)],{detached:true,stdio:'ignore',env,cwd:input.cwd || process.cwd()}); child.unref(); }
  try { const result=await ensure(rpc,env,input.transcript_path,input.cwd || process.cwd());
    await mkdir(sessionDir(env),{recursive:true}); await writeFile(join(sessionDir(env),'epoch'),result.epoch,{flag:'wx'}).catch(()=>{}); await writeFile(join(sessionDir(env),'workspace.json'),JSON.stringify({workspaceId:result.workspaceId,agentId:result.agentId}));
    if(env.CLAUDE_ENV_FILE) await appendFile(env.CLAUDE_ENV_FILE,`export PASEO_AGENT_ID=${shellQuote(result.agentId)}\nexport PASEO_AGENT_SERVER_ID=${shellQuote(result.serverId)}\nexport PASEO_WORKSPACE_ID=${shellQuote(result.workspaceId)}\n`);
    return redact(`Paseo agent: ${result.agentId}\n${workspaceInstructions(result.workspaceId)}\n${instructions}\n`, env);
  } catch(error) { return `Mac Mini 接入失败：${safeReason(error,env)}；后台将重试。\n`; }
}
export async function install(home, artifact, run = execFileSync) {
  const dir=join(home,'.claude'), path=join(dir,'settings.json'); await mkdir(dir,{recursive:true});
  let settings={}; try {settings=JSON.parse(await readFile(path,'utf8'));} catch(e) {if(e.code!=='ENOENT') throw e;}
  settings.hooks ||= {};
  for(const [event,subcommand] of [['SessionStart','hook-session-start'],['PermissionRequest','hook-permission-request']]) { settings.hooks[event] ||= []; const command=`node ${shellQuote(artifact)} ${subcommand}`; if(!settings.hooks[event].some(x=>x.hooks?.some(h=>h.type==='command' && h.command===command))) settings.hooks[event].push({hooks:[{type:'command',command}]}); }
  await writeFile(path,JSON.stringify(settings,null,2)+'\n');
  let exists=false; try {run('claude',['mcp','get','paseo'],{stdio:'ignore'}); exists=true;} catch {}
  if(!exists) run('claude',['mcp','add','--scope','user','paseo','--','node',artifact,'mcp'],{stdio:'ignore'});
}
export async function wait(env=process.env,rpc=createRpc(env), opts={}) {
  const dir=sessionDir(env), epochPath=join(dir,'epoch'); await mkdir(dir,{recursive:true}); let epoch=await readFile(epochPath,'utf8').catch(()=>null), delay=500, pending=null, registered=false;
  for (;;) { try {
    if(!pending) { if(!registered) {await ensure(rpc,env,opts.transcript || ''); registered=true;} const result=await rpc(pollInbox,{...context(env),afterSeq:0,waitMs:20000});
      if(epoch && epoch!==result.epoch) { (opts.print || console.log)('Mac 上的插件重启过，之前没取走的消息已丢失'); registered=false; }
      epoch=result.epoch; await writeFile(epochPath,epoch); if(!result.items.length) continue;
      for(const item of result.items) (opts.print || console.log)(redact(`seq: ${item.seq} delivery: ${item.delivery}\n${item.text}`,env));
      pending=result.items.at(-1).seq;
    }
    await rpc(ackInbox,{...context(env),seq:pending}); return;
  } catch(error) { if(String(error).includes('not_opened')) registered=false; await (opts.sleep || sleep)(delay); delay=Math.min(delay*2,10000); } }
}
export async function mcp(env=process.env,rpc=createRpc(env), input=process.stdin, output=process.stdout) {
  const send = x => output.write(redact(JSON.stringify(x),env)+'\n');
  let remoteInitialized=false, registered=false, stopped=false, recoveryRunning=false, timer;
  const prepare=async()=>{
    if(!env.PASEO_MINI_HOST || !env.CLAUDE_CODE_REMOTE_SESSION_ID) throw Error('Paseo 未配置');
    if(!registered) {await ensure(rpc,env,''); registered=true;}
    if(!remoteInitialized) {await remoteInit(rpc,env); remoteInitialized=true;}
  };
  const call=async message=>{
    try {await prepare(); const result=await rpc(forwardMcp,{...context(env),message});
      const response=result.messages.find(x=>x.id===message.id); if(result.status>=400 || !response) throw Error('Paseo MCP 未返回响应'); return response;
    } catch(error) {remoteInitialized=false; if(String(error).includes('not_opened')) registered=false; throw error;}
  };
  let serial=Promise.resolve();
  const callSerial=message=>{const operation=serial.then(()=>call(message)); serial=operation.then(()=>{},()=>{}); return operation;};
  const recover=()=>{
    if(recoveryRunning) return; recoveryRunning=true;
    const attempt=async()=>{
      if(stopped) {recoveryRunning=false; return;}
      try {const response=await callSerial({jsonrpc:'2.0',id:'cloud-recovery-list',method:'tools/list'}); if(response.error) throw Error('Paseo 工具列表不可用');
        if(!stopped) send({jsonrpc:'2.0',method:'notifications/tools/list_changed'}); recoveryRunning=false;
      } catch {if(!stopped) {timer=setTimeout(attempt,2000); timer.unref();} else recoveryRunning=false;}
    };
    timer=setTimeout(attempt,2000); timer.unref();
  };
  try {for await (const line of readline.createInterface({input,crlfDelay:Infinity})) {
    let m; try {m=JSON.parse(line);} catch {continue;}
    if(m.method==='initialize') {let workspaceId=env.PASEO_WORKSPACE_ID; if(!workspaceId && env.CLAUDE_CODE_REMOTE_SESSION_ID) {try {workspaceId=JSON.parse(await readFile(join(sessionDir(env),'workspace.json'),'utf8')).workspaceId;} catch {}} send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params?.protocolVersion || '2025-03-26',capabilities:{tools:{listChanged:true}},serverInfo:{name:'paseo',version:'0.1.0'},instructions:workspaceInstructions(workspaceId)+'\n'+instructions}}); continue;}
    if(m.id===undefined) continue;
    try {const response=await callSerial(m); send(response); if(m.method==='tools/list' && response.error) recover();}
    catch(error) {send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:`Paseo 工具调用失败：${safeReason(error,env)}`}}); if(m.method==='tools/list') recover();}
  }} finally {stopped=true; clearTimeout(timer);}
}
async function main() {
  const [cmd,arg]=process.argv.slice(2), env=process.env;
  if(cmd==='install-claude-config') return install(env.HOME,resolve(fileURLToPath(import.meta.url)));
  if(cmd==='hook-permission-request') {let s=''; for await(const c of process.stdin) s+=c; try {permissionHook(JSON.parse(s),env);} catch {} return;}
  const rpc=createRpc(env);
  try {
    if(cmd==='permission-notify') {let s=''; for await(const c of process.stdin) s+=c; try {await notifyRequest(JSON.parse(s),env,rpc);} catch {} return;}
    if(cmd==='hook-session-start') {let s=''; for await(const c of process.stdin) s+=c; let input; try {input=JSON.parse(s);} catch {return;} process.stdout.write(await hook(input,env,rpc)); return;}
    if(cmd==='mcp') return await mcp(env,rpc);
    if(cmd==='forward' && eligible(env) && arg) return await forward(arg,env,rpc,process.argv[4] === undefined ? undefined : Number(process.argv[4]));
    if(cmd==='wait' && env.PASEO_MINI_HOST && env.CLAUDE_CODE_REMOTE_SESSION_ID) return await wait(env,rpc);
  } finally {await rpc.close();}
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{process.stderr.write('Paseo 云端程序执行失败。\n'); process.exitCode=1;});
