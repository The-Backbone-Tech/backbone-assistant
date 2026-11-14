import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,timingSafeEqual} from 'node:crypto';
import { DiscordAdapter, type DiscordAdapterConfig } from '@chat-adapter/discord';
import { TeamsAdapter, type TeamsAdapterConfig } from '@chat-adapter/teams';
import { ConsoleLogger, type Adapter, type WebhookOptions } from 'chat';

export interface BreadthAdapterOptions {
  discord?: {token:string; applicationId:string; publicKey:string; apiUrl?:string};
  teams?: {appId:string; password:string; tenantId:string; apiUrl?:string;
    /** Trusted composition only: a relay must authenticate the exact request bytes. */
    webhookVerifier?: TeamsAdapterConfig['webhookVerifier']; token?:TeamsAdapterConfig['token']};
}
/** Keep SDK parsing, authentication and posting, but do not let its Gateway path bypass durable intake. */
export class DurableDiscord extends DiscordAdapter {
  private deadline:number;
  constructor(config:DiscordAdapterConfig,deadline:number){super(config);this.deadline=deadline;}
  override async handleWebhook(request:Request,options?:WebhookOptions){
    const supplied=request.headers.get('x-discord-gateway-token');
    if(supplied!==null){
      const digest=(value:string)=>createHash('sha256').update(value).digest();
      if(!timingSafeEqual(digest(supplied),digest(await this.resolveBotToken())))return new Response('Invalid gateway token',{status:401});
      await this.resolveApplicationId();
      let event:Parameters<DiscordAdapter['parseMessage']>[0];
      try{event=await request.json();}catch{return new Response('Invalid JSON',{status:400});}
      // Bypass the SDK's ordinary string comparison only after authenticating here.
      return this.handleForwardedGatewayEvent(event as Parameters<DurableDiscord['handleForwardedGatewayEvent']>[0],options);
    }
    return super.handleWebhook(request,options);
  }
  protected override async handleForwardedMessage(data:{guild_id?:string;channel_id:string;channel_type?:number;author:{bot?:boolean}},options?:WebhookOptions) {
    if(data.guild_id || data.author.bot || !this.chat)return;
    // Discord's raw MESSAGE_CREATE omits channel_type. Resolve it before admitting
    // a DM; absence of a guild alone also describes a multi-person group DM.
    let channelType=data.channel_type;
    if(channelType===undefined){
      const response=await this.discordFetch(`/channels/${encodeURIComponent(data.channel_id)}`,'GET');
      channelType=(await response.json() as {type?:number}).type;
    }
    if(channelType!==1)return;
    const message=this.parseMessage({...data,channel_type:channelType});
    await this.chat.processMessage(this,message.threadId,message,options);
  }
  protected override async discordFetch(path:string,method:string,body?:unknown):Promise<Response>{
    const response=await fetch(`${this.apiBaseUrl}${path}`,{method,headers:{Authorization:`Bot ${await this.resolveBotToken()}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(this.deadline)});
    // Conservatively UNKNOWN: never retry a send on an ambiguous provider error.
    if(!response.ok)throw new Error('Discord did not confirm this request.');
    return response;
  }
}
/** Apply the maintained Teams HTTP client's interceptor to cloned connector clients too. */
class BoundedTeams extends TeamsAdapter {
  private claims=new AsyncLocalStorage<Record<string,unknown>|undefined>();
  private guarded=false;
  override async handleWebhook(request:Request,options?:WebhookOptions){
    let claims:Record<string,unknown>|undefined;
    try{claims=JSON.parse(Buffer.from((request.headers.get('authorization')??'').replace(/^Bearer /,'').split('.')[1]??'','base64url').toString());}catch{}
    return this.claims.run(claims,()=>super.handleWebhook(request,options));
  }
  override async initialize(chat:Parameters<TeamsAdapter['initialize']>[0]){
    await super.initialize(chat);
    if(this.guarded)return;
    const receive=this.app.server.onRequest!;
    this.app.server.onRequest=event=>{
      // This callback runs only AFTER native JWT verification of the same request.
      // Classic Bot Framework claims need no tid; Microsoft attests its activity body.
      // Agent 365/Entra identity is outside this personal bot's authority.
      const claims=this.claims.getStore();
      if(!this.config.webhookVerifier&&(claims?.iss!==this.app.cloud.tokenIssuer||(claims.tid!==undefined&&claims.tid!==this.config.appTenantId)))return Promise.resolve({status:401});
      return receive(event);
    };
    this.guarded=true;
  }
  constructor(config:TeamsAdapterConfig,deadline:number){
    super(config);
    this.app.client.use({request:({config})=>({...config,timeout:deadline})});
    this.app.api.http.use({request:({config})=>({...config,timeout:deadline})});
  }
}
export function breadthAdapters(options:BreadthAdapterOptions,deadline:number):Record<string,Adapter>{
  const adapters:Record<string,Adapter>={};
  if(options.discord){
    const d=options.discord;
    if(!d.token||!d.applicationId||!/^[a-f0-9]{64}$/i.test(d.publicKey))throw new Error('Discord needs a bot token, application ID and public key.');
    adapters.discord=new DurableDiscord({botToken:d.token,applicationId:d.applicationId,publicKey:d.publicKey,apiUrl:d.apiUrl??'https://discord.com/api/v10',mentionRoleIds:[],respondToChannelIds:[],respondToGlobalMentions:false,userName:'assistant',logger:new ConsoleLogger('silent')},deadline);
  }
  if(options.teams){
    const t=options.teams;
    if(!t.appId||!t.password||!t.tenantId)throw new Error('Teams needs an application ID, password and tenant ID.');
    adapters.teams=new BoundedTeams({appId:t.appId,appPassword:t.password,appTenantId:t.tenantId,appType:'SingleTenant',apiUrl:t.apiUrl??'',userName:'assistant',logger:new ConsoleLogger('silent'),appLogger:{debug(){},info(){},warn(){},error(){},trace(){},log(){},child(){return this;}},...(t.token?{token:t.token}:{}),...(t.webhookVerifier?{webhookVerifier:t.webhookVerifier}:{})},deadline);
  }
  return adapters;
}
