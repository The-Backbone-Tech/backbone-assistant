import { app, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { accessState, folders, isFolder, loginItemState, trayMenu, type AccessState } from './mac-presence-model.ts';

let states: Record<string, AccessState> = Object.fromEntries(folders.map(folder => [folder, 'unknown']));
let tray: Tray | undefined;
let sharingOrigin:string|undefined;
let refreshMenu=()=>{};
export function updateSharingPresence(origin?:string){sharingOrigin=origin;refreshMenu();}

export function registerMacPresence(refuseOthers: (event: IpcMainInvokeEvent) => void, mainWindow: () => Electron.BrowserWindow | undefined, open: () => Electron.BrowserWindow, isQuitting: () => boolean, name: string) {
  if (process.platform !== 'darwin') return;
  ipcMain.handle('mac-presence', (event) => {
    refuseOthers(event);
    return { folders: states, login: loginItemState(process.platform, app.isPackaged, app.isPackaged && app.getLoginItemSettings().openAtLogin) };
  });
  ipcMain.handle('mac-file-access', async (event, folder: unknown) => {
    refuseOthers(event);
    if (!isFolder(folder)) throw new Error('Invalid folder');
    try { await readdir(join(app.getPath('home'), folder)); states[folder] = accessState(null); }
    catch (error) { states[folder] = accessState(error as NodeJS.ErrnoException); }
    return { ...states };
  });
  ipcMain.handle('mac-files-and-folders', (event) => { refuseOthers(event); return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'); });
  ipcMain.handle('mac-full-disk-access', (event) => { refuseOthers(event); return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'); });
  ipcMain.handle('mac-login-item', (event, enabled: unknown) => {
    refuseOthers(event);
    if (!app.isPackaged || typeof enabled !== 'boolean') throw new Error('Login item unavailable');
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
  const show = (newChat: boolean) => {
    if (isQuitting()) return;
    const win = mainWindow() ?? open();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    if (newChat) {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => win?.webContents.send('mac-new-chat'));
      else win.webContents.send('mac-new-chat');
    }
  };
  tray = new Tray(nativeImage.createFromNamedImage('NSActionTemplate'));
  tray.setToolTip(name);
  refreshMenu=()=>tray?.setContextMenu(Menu.buildFromTemplate(trayMenu(name,sharingOrigin).map(item => ({ label: item.label, enabled:item.action!=='sharing-status', click: () => {
    if(item.action==='quit'){app.quit();return;}
    show(item.action==='new');
    if(item.action==='sharing-off')mainWindow()?.webContents.send('mac-sharing-settings');
  } }))));
  refreshMenu();
  tray.on('click', () => show(false));
}
