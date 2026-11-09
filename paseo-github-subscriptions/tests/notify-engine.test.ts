import test from 'node:test';import assert from 'node:assert/strict';
import {Engine,expireOutbox,emptyState,type Notice} from '../server/notify/engine.ts';
const question={name:'AskUserQuestion',kind:'question',title:'怎样处理？',input:{questions:[{question:'怎样处理？',options:[{label:'先修复（推荐）'},{label:'等待'}]}]}};
function fixture(){const sent:Notice[]=[];const audit:any[]=[];let pending=true;const e=new Engine({hostId:'macmini',machine:'macmini',delivery:'live',mains:['main'],children:{}},emptyState(),async()=>{},async(n)=>{sent.push(n)},async()=>pending,async(a)=>{audit.push(a)});return{e,sent,audit,resolve:()=>{pending=false}};}
test('新问题全天立即推送，附推荐项，重复钩子与重载按permission id去重',async()=>{
 const f=fixture();const now=Date.parse('2026-11-04T15:00:00+08:00');
 await f.e.asked('main','permission',question,now);await f.e.tick(now);await f.e.asked('main','permission',question,now+1);await f.e.tick(now+1);
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].permissionId,'permission');assert.deepEqual(f.sent[0].questionSummary.recommended,[{label:'先修复（推荐）'}]);
 const e=new Engine(f.e.config,JSON.parse(JSON.stringify(f.e.state)),async()=>{},async(n)=>{f.sent.push(n)},async()=>true);
 await e.enqueue('asked','main',question,'另一个回调键',undefined,'permission',now+2);await e.tick(now+2);assert.equal(f.sent.length,1);
});
test('回答、本轮结束、空闲、普通会话与普通权限请求均记录且不投递',async()=>{
 const f=fixture();for(const event of ['answered','user_reply','turn_end','idle'] as const)await f.e.enqueue(event,'main',{},event);
 await f.e.enqueue('error','ordinary',{},'ordinary-error');await f.e.enqueue('error','main',{callId:'rg-no-match'},'tool-error');await f.e.asked('ordinary','p1',question);await f.e.asked('main','p2',{name:'Bash',kind:'tool'});
 await f.e.tick();assert.equal(f.sent.length,0);assert.equal(f.audit.filter(a=>a.phase==='recorded-only').length,8);
});
test('仅主会话错误、新项目、新工作区推Grok，子会话完成仅记录',async()=>{
 const f=fixture();for(const event of ['error','new_project','new_workspace'] as const)await f.e.enqueue(event,event==='error'?'main':'',{},event);
 f.e.metadata({id:'orphan',parentAgentId:'missing'});await f.e.turnEnded('orphan','t',{kind:'completed'});await f.e.tick();
 assert.deepEqual(f.sent.map(n=>n.event).sort(),['error','new_project','new_workspace'].sort());
});
test('已回答的问题取消失败重试，不产生answered推送',async()=>{
 const f=fixture();await f.e.asked('main','p',question,1000);f.e.send=async()=>{throw Error('离线')};await f.e.tick(1000);assert.equal(f.e.state.outbox.length,1);
 f.resolve();await f.e.resolved('main','p',{behavior:'allow'},true,2000);await f.e.tick(4000);assert.equal(f.e.state.outbox.length,0);assert.equal(f.sent.length,0);
});
test('待答主会话暂缓投递，保留同一事件标识且不算发送失败，解除后送达',async()=>{
 const f=fixture();await f.e.enqueue('error','child',{summary:'合并 master 失败，需要复盘'},'failed',{agentId:'main'},undefined,0);const id=f.e.state.outbox[0].notice.id;
 f.e.send=async()=>{throw Object.assign(Error(),{deferred:true,reason:'main_has_pending_question'})};await f.e.tick(0);assert.equal(f.e.state.outbox[0].attempts,0);
 f.e.send=async n=>{f.sent.push(n)};await f.e.tick(10000);assert.equal(f.sent[0].id,id);assert.equal(f.e.state.outbox.length,0);
});
test('旧版静默事件批次重载后丢弃，不重放；子会话失败不再因超时升级Grok',async()=>{
 const f=fixture();await f.e.commandFailed('child',{summary:'合并 master 失败，需要复盘'},'fail',{agentId:'main'},0,'error');await f.e.tick(0);await f.e.tick(3600000);assert.equal(f.sent.length,1);assert.ok(f.sent[0].target);
 const n={...f.sent[0],event:'idle' as const,target:undefined,events:undefined};f.e.state.outbox.push({notice:n,attempts:0,next:0});await f.e.tick(3600001);assert.equal(f.sent.length,1);assert.equal(f.e.state.outbox.length,0);
});
test('主会话错误60秒合并，重试保持批次和各成员幂等标识',async()=>{
 const f=fixture();f.e.config.coalesceWindowSeconds=60;await f.e.enqueue('error','main',{},'e1',undefined,undefined,0);await f.e.enqueue('error','main',{},'e2',undefined,undefined,1000);
 await f.e.tick(59999);assert.equal(f.sent.length,0);const original=f.e.send;f.e.send=async()=>{throw Error()};await f.e.tick(60000);const id=f.e.state.outbox[0].notice.id;f.e.send=original;await f.e.tick(63000);assert.equal(f.sent.length,1);assert.equal(f.sent[0].id,id);assert.equal(f.sent[0].events?.length,2);assert.ok(f.e.state.seen.e1!==undefined&&f.e.state.seen.e2!==undefined);
});

test('迁移创建的已登记主会话忽略创建者路由：结束只记录、错误及新问题发Grok',async()=>{
 const f=fixture();f.e.metadata({id:'main',parentAgentId:'migration',labels:{'paseo.parent-agent-id':'migration'}});f.e.config.children.main={agentId:'migration'};
 await f.e.turnEnded('main','normal',{kind:'completed'},{agentId:'migration'},0);await f.e.tick(0);assert.equal(f.sent.length,0);
 await f.e.turnEnded('main','failed',{kind:'failed'},{agentId:'migration'},1);await f.e.asked('main','migration-question',question,2);await f.e.tick(2);
 assert.deepEqual(f.sent.map(n=>n.event),['error','asked']);assert.ok(f.sent.every(n=>!n.target&&!(n.data as any)?.orphaned));
});
test('登记表接任后，旧版孤儿和迁移工具目标积压重新分类，不能再推孤儿完成',async()=>{
 const f=fixture();f.e.config.mains=[];f.e.metadata({id:'new',parentAgentId:'migration'});
 await f.e.enqueue('error','new',{summary:'需要复盘'},'legacy',{agentId:'migration'},undefined,0);
 f.e.state.outbox[0].notice.event='subagent_done';
 const queued=f.e.state.outbox[0];queued.notice.data={...(queued.notice.data as object),orphaned:true};delete queued.notice.target;
 f.e.config.mains=['new'];await f.e.tick(0);assert.equal(f.sent.length,0);assert.equal(f.e.state.outbox.length,0);
 const record=f.audit.find(a=>a.phase==='recorded-only');assert.equal(record.notice.event,'turn_end');assert.ok(!record.notice.data.orphaned);
});

test('子会话普通命令错误/后台完成/完结不叫醒主会话，待答与需接续事件保留',async()=>{
 const f=fixture();
 await f.e.enqueue('error','child',{callId:'c1',detail:{command:'make test',exitCode:2}},'cmd-noise',{agentId:'main'},undefined,0);
 await f.e.enqueue('bg_cmd_done','child',{callId:'c2'},'bg-noise',{agentId:'main'},undefined,0);
 await f.e.enqueue('subagent_done','child',{},'done-noise',{agentId:'main'},undefined,0);
 await f.e.enqueue('asked','child',question,'child-q',{agentId:'main'},'perm1',0);
 await f.e.enqueue('error','child',{summary:'合并 master 失败，需要复盘'},'child-need',{agentId:'main'},undefined,0);
 await f.e.tick(0);
 assert.deepEqual(f.sent.map(n=>n.key).sort(),['child-need','child-q']);
 assert.equal(f.audit.filter(a=>a.phase==='recorded-only').length,3);
});
test('重载不补发启动前积压，仍待答的问题经pending重建后投递',async()=>{
 const f=fixture();const old=Date.parse('2026-11-04T12:00:00Z');
 await f.e.enqueue('error','main',{},'legacy-error',undefined,undefined,old);
 await f.e.asked('main','p9',question,old);
 f.e.send=async()=>{throw Error('离线')};await f.e.tick(old);
 assert.equal(f.e.state.outbox.length,2);
 const state2=JSON.parse(JSON.stringify(f.e.state));
 const boot=old+3600_000;
 assert.deepEqual(expireOutbox(state2,boot,boot).map(d=>d.reason),['before-boot','before-boot']);
 assert.equal(state2.outbox.length,0);
 const e2=new Engine(f.e.config,state2,async()=>{},async n=>{f.sent.push(n)},async()=>true,async a=>{f.audit.push(a)});
 await e2.tick(boot);
 assert.deepEqual(f.sent.map(n=>n.event),['asked']);assert.equal(f.sent[0].permissionId,'p9');
});
test('积压重试有保质期：超龄或超试的旧事件清理且不再发送',async()=>{
 const f=fixture();const now=31*60_000;
 await f.e.enqueue('error','main',{},'stale-job',undefined,undefined,0);
 await f.e.enqueue('error','main',{},'tired-job',undefined,undefined,now-1000);
 f.e.state.outbox[1].attempts=12;
 await f.e.tick(now);
 assert.equal(f.sent.length,0);assert.equal(f.e.state.outbox.length,0);
 assert.deepEqual(f.audit.filter(a=>a.phase==='outbox-expired').map(a=>a.reason).sort(),['stale','too-many-attempts']);
});
test('子会话完结不通知主会话或Grok，旧队列及批次同样过滤',async()=>{
 const f=fixture();await f.e.enqueue('subagent_done','child',{},'new-done',{agentId:'main'},undefined,0);
 assert.equal(f.e.state.outbox.length,0);
 for(const [key,target] of [['legacy-parent',{agentId:'main'}],['legacy-orphan',undefined]] as const){
  await f.e.enqueue('error',target?'child':'main',{summary:'需要复盘'},key,target,undefined,0);
  const job=f.e.state.outbox.at(-1)!;job.notice.event='subagent_done';job.notice.data={orphaned:!target};
 }
 await f.e.enqueue('error','main',{},'batch-error',undefined,undefined,0);
 const job=f.e.state.outbox.at(-1)!;job.notice.events=[{...job.notice,event:'subagent_done',key:'batch-done'},{...job.notice}];
 await f.e.tick(0);assert.equal(f.sent.length,1);assert.equal(f.sent[0].event,'error');assert.equal(f.sent[0].events?.length,1);assert.equal(f.e.state.outbox.length,0);
});
test('提问结束时通知页面记录；已送达但不再等待的提问在对账时清出待答状态',async()=>{
 const f=fixture();const closed:string[]=[];f.e.onResolved=(agentId,requestId)=>{closed.push(`${agentId}/${requestId}`)};
 await f.e.asked('main','p1',question,1000);await f.e.asked('main','p2',question,1000);await f.e.tick(1000);assert.equal(f.sent.length,2);
 await f.e.resolved('main','p1',{behavior:'allow'},true,2000);assert.deepEqual(closed,['main/p1']);
 // 送达后 tick 不再检查 p2；对账发现已不在等待才清掉。连接失败的不清。
 f.e.isPending=async()=>{throw Error('断开')};await f.e.reconcilePending(3000);assert.ok(Object.keys(f.e.state.pending).length===1);
 f.resolve();f.e.isPending=async()=>false;await f.e.reconcilePending(3000);assert.deepEqual(f.e.state.pending,{});assert.deepEqual(closed,['main/p1','main/p2']);
});
