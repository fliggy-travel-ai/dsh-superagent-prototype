import type {Notice} from './engine.ts';
export async function deliverToCurrentMain(notice:Notice,actions:{
 resolve:(id:string)=>Promise<{agentId:string|null}>;
 pending:(id:string)=>Promise<boolean|null>;
 send:(id:string)=>Promise<void>;
}):Promise<'sent'|'orphan'>{
 const original=notice.target!;
 const current=await actions.resolve(original.agentId);
 if(!current.agentId){
  const ended=notice.event==='subagent_done'||(notice.event==='error'&&!!(notice.data as any)?.outcome);
  if(!ended)throw Object.assign(Error('无现任主会话，记录事件'),{suppressed:true});
  notice.event='subagent_done';
  delete notice.target;
  notice.data={...(notice.data as object),orphaned:true,reason:'子会话已结束，但当前登记表没有对应主会话',previousTarget:original};
  return 'orphan';
 }
 const pending=await actions.pending(current.agentId);
 if(pending===null||pending)throw Object.assign(Error('暂缓主会话通知'),{deferred:true,reason:pending?'main_has_pending_question':'main_unavailable'});
 notice.target={...original,agentId:current.agentId};
 await actions.send(current.agentId);
 return 'sent';
}
