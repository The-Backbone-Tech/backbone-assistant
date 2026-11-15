export interface BrowserState {
  externalDispatched?: true;
  requestRefused?: true;
  url: string;
  title: string;
  phase: 'empty' | 'loading' | 'ready' | 'failed' | 'blocked' | 'stopped';
  detail?: string;
  /** The network error name, kept for a developer behind Details; never the sentence a person reads. */
  technical?: string;
  back: boolean;
  forward: boolean;
}
export type BrowserRequest = { action: 'state' | 'navigate' | 'back' | 'forward' | 'reload' | 'stop' | 'external' | 'focus'; url?: string; typed?: true }
  | { action: 'layout'; visible: boolean; bounds: { x: number; y: number; width: number; height: number } };
