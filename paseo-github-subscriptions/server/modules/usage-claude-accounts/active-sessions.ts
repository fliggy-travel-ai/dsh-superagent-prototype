import {readdir,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {paseoHome} from './providers.ts';
export function countActiveSessions(agents: Array<{id:string;provider:string;workspaceId?:string|null;lastStatus?:string;status?:string;archivedAt?:string|null;requiresAttention?:boolean;attentionReason?:string|null;labels?:Record<string,string>}>,providers:Set<string>,archivedWorkspaces:ReadonlySet<string>=new Set()):number {
 const seen=new Set<string>();
 for(const a of agents){
  const status=a.status||a.lastStatus||'';
  if(!providers.has(a.provider.split('/')[0])||a.archivedAt||status==='closed'||(a.workspaceId&&archivedWorkspaces.has(a.workspaceId)))continue;
  if(a.labels?.['paseo.parent-agent-id']&&(!status||status==='idle'))continue;
  seen.add(a.id);
 }
 return seen.size;
}
export class ActiveSessions {
 private snapshot:Promise<any[]>|undefined;private at=0;
 private readonly home:string;
 constructor(home:string=paseoHome(process.env)){this.home=home;}
 private async agents(){
  if(this.snapshot&&Date.now()-this.at<3000)return this.snapshot;
  this.at=Date.now();
  this.snapshot=(async()=>{
   const root=join(this.home,'agents');const result:any[]=[];
   const walk=async(dir:string)=>{for(const entry of await readdir(dir,{withFileTypes:true})){
    const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);
    else if(entry.name.endsWith('.json')){try{const a=JSON.parse(await readFile(path,'utf8'));if(a.id&&a.provider)result.push(a);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   }};
   await walk(root);return result;
  })();
  try{return await this.snapshot;}catch(e){this.snapshot=undefined;throw e;}
 }
 async count(env:NodeJS.ProcessEnv){
  const config=JSON.parse(await readFile(join(this.home,'config.json'),'utf8'));
  const home=env.HOME||homedir();const directory=env.CLAUDE_CONFIG_DIR||join(home,'.claude');
  const providers=new Set<string>();
  if(directory===join(process.env.HOME||homedir(),'.claude'))providers.add('claude');
  for(const [id,value] of Object.entries(config.agents?.providers||{})){
   const p=value as any;if(id!=='claude'&&p.extends!=='claude')continue;
   if((p.env?.CLAUDE_CONFIG_DIR||join(process.env.HOME||homedir(),'.claude'))===directory)providers.add(id);
  }
  let workspaces:Array<{workspaceId:string;archivedAt?:string|null}>=[];
  try{workspaces=JSON.parse(await readFile(join(this.home,'projects','workspaces.json'),'utf8'));}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const archivedWorkspaces=new Set(workspaces.filter(w=>w.archivedAt).map(w=>w.workspaceId));
  return countActiveSessions(await this.agents(),providers,archivedWorkspaces);
 }
}
