// The person's answer to an asked write on the api line (a send, a queued message, a goal set or run, a
// schedule), owned by the main process (docs/adr/0002-api-line.md). Any process of their user can reach
// the socket; only they can click here. Don't allow is the default button, so a stray Return says no.
// The line resolves the write as it will run (its words, names, effective settings, a goal run's budget
// and goal, a schedule's times) and runs exactly that after the click; this only shows it.
import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { askWords, type LineAsk } from '@backbone-next/platform/composition/api-line';
import { brand } from '../src/brand';

export async function confirmLine(ask: LineAsk, signal: AbortSignal): Promise<boolean> {
  const { message, detail } = askWords(ask, brand.name);
  const options: MessageBoxOptions = {
    type: 'question',
    title: 'Command line',
    message,
    detail,
    buttons: ask.method === 'threads.checked' ? ['Mark as checked', 'Cancel'] : ['Allow', 'Don\'t allow'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    signal,
  };
  const win = BrowserWindow.getAllWindows()[0];
  win?.show();
  app.dock?.bounce('informational');
  const { response } = await (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));
  return response === 0;
}
