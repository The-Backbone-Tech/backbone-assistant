import {gatewayRetry} from './gateway-retry.ts';
import timers from 'node:timers/promises';
import { type DurableDiscord } from './breadth-adapters.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { outsideHomeLocks } from '@backbone-next/platform/composition/home-lock';
import { intakeWorkers } from './intake.ts';
import { ownService } from './ownership.ts';
import { Chat, type Message, type StateAdapter } from 'chat';
import { deliveries } from './delivery.ts';
import { createMemoryState } from '@chat-adapter/state-memory';
import { hostConsumer, type ChannelHost } from './host-consumer.ts';
import type { TurnSettings } from '@backbone-next/platform';
import { Ledger, type Inbound, type Provider } from './ledger.ts';

import { channelAdapters, type ChannelAdapterOptions } from './adapters.ts';

export interface ChannelOptions extends ChannelAdapterOptions {
  home: string;
  reportProblem?: (text: string) => void;
  retryBaseMs?: number;
  projectId?: string;
  settings?: TurnSettings;
  /** In-process test consumer for exercising durable transport without a model. */
  consume?: (message: Inbound) => Promise<void>;
}

export function startChannels(host: ChannelHost | undefined, options: ChannelOptions) {
  return ownService(options.home,()=>startService(host,options));
}
async function startService(host: ChannelHost | undefined, options: ChannelOptions) {
  if (host && (!options.projectId || !options.settings)) throw new Error('Channel turns need a project and turn settings.');
  const ledger = new Ledger(options.home);
  const adapters = channelAdapters(options);
  // SDK dedupe must not suppress a provider retry before Backbone records it.
  const state = createMemoryState();
  const get = state.get.bind(state);
  state.get = key => key.startsWith('slack:event-delivered:') ? Promise.resolve(null) : get(key);
  const remember = state.setIfNotExists.bind(state);
  state.setIfNotExists = (key, value, ttl) => /^(dedupe:|slack:event-delivered:|telegram:webhook-update:)/.test(key) ? Promise.resolve(true) : remember(key,value,ttl);
  const bot = new Chat({ userName: 'assistant', adapters, state: state as StateAdapter, concurrency: 'queue', logger: 'silent' });
  ledger.recoverDeliveries();
  const delivery = deliveries(ledger,adapters);
  let stopped = false;
  const report=options.reportProblem??(()=>{});
  const consumer = host && options.projectId && options.settings ? hostConsumer(host,ledger,{home:options.home,projectId:options.projectId,settings:options.settings},delivery.post,()=>stopped) : undefined;
  let syncing = Promise.resolve();
  const sync = () => { syncing = syncing.then(async()=>{ if (!stopped) await consumer?.sync(); }).catch(()=>report('channels: reply projection is unavailable; recorded work is retained.')); };
  const intake=intakeWorkers(ledger,async m=>{
    if(!m.direct)return {done:true}; // Legacy rows without a DM attestation cannot authorize work.
    if (ledger.pair(m.provider,m.sender,m.text.trim())) {
      await delivery.post(`paired:${m.provider}:${m.id}`,m.provider,m.conversation,'Account bound. You can give me work here.',{sender:m.sender,generation:ledger.bindingVersion(m.provider,m.sender)});
    } else if (!ledger.bound(m.provider,m.sender) || m.bindingVersion!==ledger.bindingVersion(m.provider,m.sender)) {
      await delivery.post(`refused:${m.provider}:${m.sender}:${ledger.bindingVersion(m.provider,m.sender)}`,m.provider,m.conversation,'This account is not bound. Bind it from the command line before giving me work.');
    } else if(!m.text.trim()){
      await delivery.post(`text-needed:${m.provider}:${m.id}`,m.provider,m.conversation,'Please send text describing the work you want me to do.',{sender:m.sender,generation:m.bindingVersion!});
    } else if (options.consume) await options.consume(m);
    else if (consumer) {const result=await consumer.consume(m);if(result.done)sync();return result;}
    else return {done:false,busy:true};
    return {done:true};
  },report,options.retryBaseMs);
  const drain=()=>intake.kick();
  const off = host?.on(e=>outsideHomeLocks(()=>{if(e.topic==='threads'){sync();drain();}else if(e.topic==='connectors'||e.topic==='material')sync();}));
  const teamContext=new AsyncLocalStorage<string|undefined>();
  const persist = (provider: Provider, conversation: string, message: Message) => {
    if (message.author.isBot || message.author.isMe || message.author.isSystem) return false;
    const raw=message.raw as {channel_type?:string|number;guild_id?:string;team_id?:string;chat?:{type?:string};conversation?:{conversationType?:string};channelData?:{tenant?:{id?:string}}};
    const tenant=raw?.channelData?.tenant?.id;
    if (!raw || (provider==='slack' ? raw.channel_type!=='im'||!raw.team_id : provider==='telegram' ? raw.chat?.type!=='private' : provider==='discord' ? raw.channel_type!==1||!!raw.guild_id : raw.conversation?.conversationType!=='personal'||!tenant||tenant!==options.teams?.tenantId)) return false;
    const sender=provider==='slack'?`${raw.team_id}:${message.author.userId}`:provider==='teams'?`${tenant}:${message.author.userId}`:message.author.userId;
    ledger.receive({provider,conversation,id:`${provider==='slack'?raw.team_id+':':''}${conversation}:${message.id}`,sender,text:message.text,direct:true});
    return true;
  };
  const original = bot.processMessage.bind(bot);
  bot.processMessage = (adapter, conversation, factory, webhookOptions) => {
    const work = (async()=>{
      const message = typeof factory === 'function' ? await factory() : factory;
      if(adapter.name==='slack') {
        const team=teamContext.getStore();if(!team)return;
        (message.raw as {team_id?:string}).team_id=team;
      }
      if(!persist(adapter.name as Provider, conversation, message))return;
      await original(adapter,conversation,message,webhookOptions);
      drain();
    })();
    // Slack invokes processMessage without awaiting it. Register before the first async parse,
    // so the webhook cannot acknowledge until our durable intake has committed.
    webhookOptions?.waitUntil?.(work);
    return work;
  };
  const handler: Parameters<typeof bot.onNewMention>[0] = async (thread, message, context) => {
    for (const item of [...(context?.skipped ?? []), message]) persist(thread.adapter.name as Provider, thread.id,item);
    drain();
  };
  bot.onSlashCommand(async event=>{
    if (event.adapter.name!=='telegram') return;
    const message=event.adapter.parseMessage(event.raw);
    persist('telegram',message.threadId,message);
    drain();
  });
  bot.onDirectMessage((thread,message,_channel,context) => handler(thread,message,context)); bot.onNewMention(handler); bot.onSubscribedMessage(handler);
  try { await bot.initialize(); } catch(e) { off?.(); await bot.shutdown().catch(()=>{}); ledger.close(); throw e; }
  for (const message of ledger.outgoing()) await delivery.replay(message.id);
  drain(); sync();
  return {
    ledger,
    /** The daemon renews the maintained SDK Gateway listener; no second message transport. */
    async discordGateway(url:string,signal:AbortSignal) {
      const adapter=adapters.discord as DurableDiscord|undefined;
      if(!adapter)return;
      const retry=gatewayRetry(options.retryBaseMs);
      while(!signal.aborted&&!stopped){
        const tasks:Promise<unknown>[]=[];
        const started=Date.now();
        try{
          const response=await adapter.startGatewayListener({waitUntil:p=>{tasks.push(p);}},180_000,signal,url);
          if(!response.ok)throw new Error('Gateway listener did not start');
          await Promise.all(tasks);
          // The SDK can swallow login failures. Only a full listener period is recovery.
          if(signal.aborted||stopped)return;
          if(Date.now()-started<180_000)throw new Error('Gateway listener ended early');
          const notice=retry.recovered();if(notice)report(notice);
        }catch{
          if(signal.aborted||stopped)return;
          const {waitMs,notice}=retry.failed();if(notice)report(notice);
          await timers.setTimeout(waitMs,undefined,{signal}).catch(()=>{});
        }
      }
    },
    async webhook(provider: Provider, request: Request): Promise<Response> {
      if (request.headers.has('x-slack-socket-token')) return new Response('Socket forwarding is not accepted',{status:401});
      if (stopped) return new Response('Service stopped', { status: 503 });
      if(!bot.webhooks[provider])return new Response('Channel is not configured',{status:404});
      const tasks: Promise<unknown>[] = [];
      let failed=false;
      let team:string|undefined;
      if(provider==='slack'){try{const payload=await request.clone().json();if(typeof payload.team_id==='string')team=payload.team_id;}catch{}}
      const response = await teamContext.run(team,()=>bot.webhooks[provider](request, { propagateHandlerErrors: true, waitUntil: p => { tasks.push(p.catch(()=>{failed=true;})); } }));
      while (tasks.length) await Promise.all(tasks.splice(0));
      drain();
      if (failed) return new Response('Intake could not be recorded',{status:503});
      return response;
    },
    async idle() { sync(); await intake.idle(); let previous; do { previous=syncing; await previous; } while(previous!==syncing); await delivery.idle(); },
    async close() { stopped = true; off?.(); const closingDelivery=delivery.close(); await intake.close(); await syncing; await closingDelivery; await bot.shutdown(); ledger.close(); }
  };
}
