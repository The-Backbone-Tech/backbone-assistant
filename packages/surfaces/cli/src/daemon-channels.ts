import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { providerSettings, readChannelConfig, PRODUCTION_DELIVERY_TIMEOUT_MS, startChannels, serveChannels, type ChannelOptions } from '@backbone-next/channels';
import { assertHomeWriteAdmission } from '@backbone-next/platform/composition/home-lock';
import { channelCredentials } from '@backbone-next/platform/credentials/channels';
import type { HomeKeys } from '@backbone-next/platform/keys';
import { chooseKeys } from '@backbone-next/platform/system-keys';
import type { Host } from '@backbone-next/platform/composition';

export async function startConfiguredChannels(host: Host, home: string, say: (text: string)=>void = ()=>{}, keys?: HomeKeys) {
  const config=readChannelConfig(home);
  if(!config?.providers.length)return undefined;
  const credentials=await channelCredentials(home,keys ?? await chooseKeys(home,process.env,undefined,{create:false}));
  const options:ChannelOptions={home,projectId:config.projectId,settings:config.settings,reportProblem:say,deliveryTimeoutMs:PRODUCTION_DELIVERY_TIMEOUT_MS};
  for(const provider of config.providers){
    const {token,verification}=await credentials.resolve(provider),apiUrl=config.baseUrls?.[provider];
    if(provider==='slack')options.slack={token,signingSecret:verification,apiUrl};
    else if(provider==='telegram')options.telegram={token,secret:verification,apiUrl};
    else Object.assign(options,providerSettings(provider,token,verification,apiUrl));
  }
  const service=await startChannels(host,options);
  let listener:Awaited<ReturnType<typeof serveChannels>>;
  try{listener=await serveChannels(service,config.port);}catch(e){await service.close();throw e;}
  const record=join(home,'channels','listener.json');
  assertHomeWriteAdmission(home,join(home,'channels'));
  writeFileSync(record,JSON.stringify({host:'127.0.0.1',port:listener.port}),{mode:0o600});
  const gatewayStop=new AbortController();
  const gateway=service.discordGateway(`http://127.0.0.1:${listener.port}/channels/discord`,gatewayStop.signal);
  return {async close(){gatewayStop.abort();await listener.close();await service.close();await gateway;assertHomeWriteAdmission(home,join(home,'channels'));rmSync(record,{force:true});}};
}
