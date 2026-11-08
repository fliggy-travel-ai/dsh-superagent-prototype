import test from 'node:test';import assert from 'node:assert/strict';import {ActiveSessions,countActiveSessions} from '../server/modules/usage-claude-accounts/active-sessions.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('按账号统计未关闭会话，包含空闲，排除归档和其他账号并按ID去重',()=>{
 const agents=[{id:'run',provider:'claude-5',lastStatus:'running'},{id:'init',provider:'claude-5',lastStatus:'initializing'},{id:'ask',provider:'claude-5',lastStatus:'idle',requiresAttention:true,attentionReason:'permission'},{id:'idle',provider:'claude-5',lastStatus:'idle'},{id:'old',provider:'claude-5',lastStatus:'running',archivedAt:'2026-01-01'},{id:'other',provider:'claude-2',lastStatus:'running'},{id:'run',provider:'claude-5',lastStatus:'running'}];
 assert.equal(countActiveSessions(agents,new Set(['claude-5'])),4);assert.equal(countActiveSessions([],new Set(['claude-5'])),0);
});
test('完成未读和出错但未关闭的会话仍计入，关闭不受注意标记影响',()=>{
 const agents=[
  {id:'done',provider:'claude-10',lastStatus:'idle',requiresAttention:true,attentionReason:'finished'},
  {id:'closed',provider:'claude-10',lastStatus:'closed',requiresAttention:true,attentionReason:'finished'},
  {id:'closed-permission',provider:'claude-10',lastStatus:'closed',requiresAttention:true,attentionReason:'permission'},
  {id:'error',provider:'claude-10',lastStatus:'error',requiresAttention:true,attentionReason:'error'},
  {id:'stale',provider:'claude-10',status:'idle',lastStatus:'running'},
 ];
 assert.equal(countActiveSessions(agents,new Set(['claude-10'])),3);
});
test('子会话只统计非空闲状态，主会话仍统计空闲状态',()=>{
 const labels={'paseo.parent-agent-id':'codex-parent','paseo.parent-server-id':'another-host'};
 const agents=[
  {id:'main-idle',provider:'claude-3',status:'idle'},
  {id:'child-idle',provider:'claude-3',status:'idle',labels},
  {id:'child-finished',provider:'claude-3',lastStatus:'idle',requiresAttention:true,attentionReason:'finished',labels},
  {id:'child-permission',provider:'claude-3',status:'idle',requiresAttention:true,attentionReason:'permission',labels},
  {id:'child-stale',provider:'claude-3',status:'idle',lastStatus:'running',labels},
  {id:'child-unknown',provider:'claude-3',labels},
  {id:'child-running',provider:'claude-3/opus',status:'running',lastStatus:'idle',labels},
  {id:'child-running',provider:'claude-3/opus',status:'running',labels},
  {id:'child-initializing',provider:'claude-3',lastStatus:'initializing',labels},
  {id:'child-error',provider:'claude-3',lastStatus:'error',labels},
  {id:'child-closed',provider:'claude-3',lastStatus:'closed',labels},
  {id:'child-archived',provider:'claude-3',status:'running',archivedAt:'2026-11-07',labels},
  {id:'other-account',provider:'claude-4',status:'running',labels},
 ];
 assert.equal(countActiveSessions(agents,new Set(['claude-3'])),4);
});
test('排除归档工作区和空闲子会话，保留空闲主会话和运行子会话',async()=>{
 const root=mkdtempSync(join(tmpdir(),'quota-archived-workspace-'));
 const previous=process.env.PASEO_HOME;process.env.PASEO_HOME=root;
 const configDir=join(root,'claude-account');
 mkdirSync(join(root,'agents'));mkdirSync(join(root,'projects'));
 writeFileSync(join(root,'config.json'),JSON.stringify({agents:{providers:{'claude-test':{extends:'claude',env:{CLAUDE_CONFIG_DIR:configDir}}}}}));
 const sessions=[
  {id:'stale-idle',provider:'claude-test',workspaceId:'archived',lastStatus:'idle'},
  {id:'main',provider:'claude-test',workspaceId:'active',lastStatus:'idle'},
  {id:'child',provider:'claude-test',workspaceId:'active',lastStatus:'running',labels:{'paseo.parent-agent-id':'main'}},
  {id:'idle-child',provider:'claude-test',workspaceId:'active',lastStatus:'idle',labels:{'paseo.parent-agent-id':'main'}},
 ];
 for(const a of sessions)writeFileSync(join(root,'agents',a.id+'.json'),JSON.stringify(a));
 const save=(archived:boolean)=>writeFileSync(join(root,'projects','workspaces.json'),JSON.stringify([
  {workspaceId:'archived',archivedAt:archived?'2026-11-05T13:08:56Z':null},
  {workspaceId:'active',archivedAt:null},
 ]));
 try{
  save(true);
  const service=new ActiveSessions();
  assert.equal(await service.count({CLAUDE_CONFIG_DIR:configDir}),2);
  // The workspace registry must be rechecked even while session metadata is cached.
  save(false);
  assert.equal(await service.count({CLAUDE_CONFIG_DIR:configDir}),3);
  save(true);
  assert.equal(await service.count({CLAUDE_CONFIG_DIR:configDir}),2);
 }finally{
  if(previous===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=previous;
  rmSync(root,{recursive:true,force:true});
 }
});
