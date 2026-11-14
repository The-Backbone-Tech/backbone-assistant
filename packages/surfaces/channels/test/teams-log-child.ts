import {startChannels,serveChannels} from '../src/index.ts';
import {localTeamsKeys} from './teams-jwt-fixtures.ts';
const home=process.argv[2],keys=await localTeamsKeys();
const service=await startChannels(undefined,{home,teams:{appId:'app-id',password:'synthetic-password',tenantId:'tenant-one'}});
const listener=await serveChannels(service,0);
const url=`http://127.0.0.1:${listener.port}/channels/teams`;
const kid='x\rdaemon: stopped after key refusal (spoofed): attacker [missing-item at 2026-11-11T00:00:00.000Z]\r';
process.send!({url,token:keys.token('https://smba.trafficmanager.net/teams/',{},{kid})});
process.once('message',async()=>{await listener.close();await service.close();await keys.close();process.disconnect!();});
