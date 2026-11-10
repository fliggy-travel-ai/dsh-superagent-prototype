import {randomUUID} from 'node:crypto';
import {DaemonClient} from '@getpaseo/client/internal/daemon-client';
import {createHostChannelTransport} from '@getpaseo/client/internal/hosts';
// SDK 0.15 导出的通道适配器，沿用已登记主机的认证和加密，不把凭据放到终端。
export async function connectRegisteredHost(origin:DaemonClient,serverId:string){
 const scope=randomUUID();const routeId=await origin.openHostRoute(serverId,scope);
 const client=new DaemonClient({url:'ws://routed-host/ws',clientId:scope,transportFactory:createHostChannelTransport(origin,serverId,scope,routeId),reconnect:{enabled:false}});
 try{await client.connect();return client;}catch(e){await client.close();throw e;}
}
