export const folders = ['Desktop', 'Documents', 'Downloads'] as const;
export type Folder = typeof folders[number];
export function isFolder(value: unknown): value is Folder { return folders.some(folder => folder === value); }
export type AccessState = 'allowed' | 'denied' | 'unavailable' | 'unknown';
export function accessState(error: { code?: string } | null): AccessState {
  return !error ? 'allowed' : error.code === 'EPERM' || error.code === 'EACCES' ? 'denied' : 'unavailable';
}
export function loginItemState(platform: string, packaged: boolean, openAtLogin: boolean): boolean | null {
  return platform === 'darwin' && packaged ? openAtLogin : null;
}
export function trayMenu(name: string, sharingOrigin?:string) {
  return [{ label: `Open ${name}`, action: 'open' }, { label: 'New chat', action: 'new' }, ...(sharingOrigin?[{label:`Sharing with other computers is on: ${sharingOrigin}`,action:'sharing-status' as const},{label:'Turn sharing off in Settings…',action:'sharing-off' as const}]:[]), { label: 'Quit', action: 'quit' }] as const;
}
