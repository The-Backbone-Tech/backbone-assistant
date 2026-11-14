import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger, providerSettings, secureChannelsHome, readChannelConfig, type ChannelConfig, type Provider } from '@backbone-next/channels';
import { channelCredentials } from '@backbone-next/platform/credentials/channels';
import { chooseKeys } from '@backbone-next/platform/system-keys';
import { assertHomeWriteAdmission, withHomeLock } from '@backbone-next/platform/composition/home-lock';
import { attachApi } from '@backbone-next/platform/doors/api-line';
import { withHome, refuseClosedApp } from './session.ts';
import { EXIT, type Api, type Io, type Parsed } from './commands.ts';

async function readTokens(input: AsyncIterable<string | Buffer>): Promise<[string,string]> {
  let body='';
  for await(const chunk of input){body+=String(chunk);if(Buffer.byteLength(body)>32770)throw new Error('Channel credential input is too long.');}
  const lines=body.trim().split(/\r?\n/);
  if(lines.length!==2||lines.some(line=>!line.trim()))throw new Error('Pipe the bot token and verification secret as two lines on standard input.');
  return [lines[0].trim(),lines[1].trim()];
}
async function defaults(parsed: Parsed) {
  const read=async(api:Api)=>{
    const projects=await api.call('projects.list',{}), project=parsed.options.project?projects.find(p=>p.id===parsed.options.project):projects[0];
    if(!project)throw new Error('Create a project first, or select an existing one with --project.');
    const model=parsed.options.model??(await api.call('models.list',{}))[0]?.id??'none';
    return {projectId:project.id,settings:{permission:parsed.options.permission,model,effort:parsed.options.effort,runsOn:'this-computer',mode:parsed.options.plan?'plan':'chat'} as ChannelConfig['settings']};
  };
  const line=await attachApi(parsed.home);
  if(line){try{return await read(line);}finally{line.close();}}
  return withHome(parsed.home,'channels connect',api=>read(api),{readOnly:true});
}
export async function channelsCommand(parsed:Parsed,io:Pick<Io,'out'|'err'>,input:AsyncIterable<string|Buffer>):Promise<number>{
  if(!existsSync(parsed.home))throw new Error('Create this data folder before configuring channels.');
  assertHomeWriteAdmission(parsed.home,join(parsed.home,'keys'),join(parsed.home,'channels'));
  secureChannelsHome(parsed.home);
  if(parsed.name==='channels connect') {
    const provider=parsed.target as Provider;
    if(!['slack','telegram','discord','teams'].includes(provider))throw new Error('Choose slack, telegram, discord or teams.');
    refuseClosedApp(parsed.home);
    const [token,verification]=await readTokens(input);
    if(provider==='discord'||provider==='teams')providerSettings(provider,token,verification);
    const chosen=await defaults(parsed), credentials=await channelCredentials(parsed.home,await chooseKeys(parsed.home,process.env,undefined,{create:false}));
    await withHomeLock(join(parsed.home,'channels','authority'),async()=>{
      const ledger=new Ledger(parsed.home);
      try {
        await credentials.connect(provider,token,verification);
        const prior=readChannelConfig(parsed.home);
        ledger.unbindAll(provider);
        ledger.set('config',{version:1,...chosen,port:parsed.options.channelPort??prior?.port??3038,providers:[...new Set([...(prior?.providers??[]),provider])],...(prior?.baseUrls?{baseUrls:prior.baseUrls}:{})} satisfies ChannelConfig);
      }finally{ledger.close();}
    });
    io.out('Channel credentials stored. Restart the daemon, then bind the account you want to use.');
    return EXIT.OK;
  }
  await withHomeLock(join(parsed.home,'channels','authority'),async()=>{
    const ledger=new Ledger(parsed.home);
    try {
      if(parsed.name==='channels bind'){
        const code=ledger.invite();io.out(parsed.json?JSON.stringify({code,expiresInSeconds:600}):`Send this one-time code to the bot within ten minutes: ${code}`);
      }else{
        const count=ledger.unbindAll();io.out(parsed.json?JSON.stringify({unbound:count}):`Unbound ${count} channel account(s).`);
      }
    }finally{ledger.close();}
  });
  return EXIT.OK;
}
