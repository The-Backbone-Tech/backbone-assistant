// Test input only: the sending child keeps its artificial five-second write delay pending.
// Its normal abort listener, driven by the actual Stop request, must release the write.
// This child holds five-second callbacks only; native handles, clearers and other delays remain.
export {};
const timeout=globalThis.setTimeout;
globalThis.setTimeout=((callback:(...args:unknown[])=>void,ms?:number,...args:unknown[])=>
  timeout(ms===5000?()=>{}:callback,ms,...args)) as typeof setTimeout;
