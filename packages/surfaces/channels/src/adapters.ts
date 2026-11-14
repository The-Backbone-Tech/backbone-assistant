import { breadthAdapters, type BreadthAdapterOptions } from './breadth-adapters.ts';
import { SlackAdapter, type SlackAdapterConfig } from '@chat-adapter/slack';
import { ConsoleLogger, type Adapter } from 'chat';
import { BoundedTelegram } from './delivery.ts';
type SlackLogger = NonNullable<NonNullable<SlackAdapterConfig['webClientOptions']>['logger']>;
const quiet: SlackLogger={debug(){},info(){},warn(){},error(){},setLevel(){},setName(){},getLevel:()=> 'error' as ReturnType<SlackLogger['getLevel']>};
export const PRODUCTION_DELIVERY_TIMEOUT_MS = 20_000;
export interface ChannelAdapterOptions extends BreadthAdapterOptions {
  deliveryTimeoutMs?: number;
  slack?: {token: string; signingSecret: string; apiUrl?: string};
  telegram?: {token: string; secret: string; apiUrl?: string};
}
/** Explicit values prevent SDK process-environment defaults from changing this home's route or authentication. */
export function channelAdapters(options:ChannelAdapterOptions):Record<string,Adapter>{
  const adapters:Record<string,Adapter>={}, deadline=options.deliveryTimeoutMs??PRODUCTION_DELIVERY_TIMEOUT_MS;
  if(options.slack){
    if(!options.slack.token||!options.slack.signingSecret)throw new Error('Slack token and signing secret are required.');
    adapters.slack=new SlackAdapter({botToken:options.slack.token,signingSecret:options.slack.signingSecret,apiUrl:options.slack.apiUrl??'https://slack.com/api/',mode:'webhook',appToken:'',socketForwardingSecret:'',encryptionKey:'',userName:'assistant',logger:new ConsoleLogger('silent'),webClientOptions:{logger:quiet,retryConfig:{retries:0},rejectRateLimitedCalls:true,timeout:deadline}});
  }
  if(options.telegram){
    if(!options.telegram.token||!options.telegram.secret)throw new Error('Telegram token and webhook secret are required.');
    adapters.telegram=new BoundedTelegram({botToken:options.telegram.token,secretToken:options.telegram.secret,apiUrl:options.telegram.apiUrl??'https://api.telegram.org',mode:'webhook',userName:'assistant',allowedUserIds:[],allowUnverifiedWebhooks:false,mentionOnReply:false,businessMode:false,nativeStreaming:false,persistThreadHistory:false,logger:new ConsoleLogger('silent')},deadline);
  }
  return {...adapters,...breadthAdapters(options,deadline)};
}
