// An unauthenticated client cannot reserve the entire sign-in pool. Old pending
// attempts may expire or be evicted; neither event is a successful sign-in.
export class SignInRateLimited extends Error {
  readonly retryAfter:number;
  constructor(retryAfter:number){super('Too many sign-in attempts. Try again later.');this.retryAfter=retryAfter;}
}
export function signInBudget(){
  const clients=new Map<string,{count:number;until:number}>();
  return {admit(client:string){
    const now=Date.now();for(const [key,value]of clients)if(value.until<=now)clients.delete(key);
    const current=clients.get(client);
    if(current&&current.count>=8)throw new SignInRateLimited(Math.max(1,Math.ceil((current.until-now)/1000)));
    if(current)current.count++;else{if(clients.size>=1024)clients.delete(clients.keys().next().value!);clients.set(client,{count:1,until:now+60_000});}
  }};
}
export function reserveSignIn<T extends {expires:number}>(attempts:Map<string,T>,key:string,value:T){
  for(const [id,pending]of attempts)if(pending.expires<=Date.now())attempts.delete(id);
  if(attempts.size>=128)attempts.delete(attempts.keys().next().value!);
  attempts.set(key,value);
}
