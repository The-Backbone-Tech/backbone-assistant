import { listNotices, readNotice } from '@backbone-next/platform/notices';
import { fileURLToPath } from 'node:url';
import { EXIT, type Io } from './commands.ts';

/** The packager writes this resource beside the installed CLI source. No home is needed. */
export function noticesCommand(json: boolean, io: Pick<Io, 'out' | 'err'>): number {
  try {
    const directory = fileURLToPath(new URL('../notices/', import.meta.url));
    const entries = listNotices(directory).map(entry => readNotice(directory, entry.id));
    io.out(json ? JSON.stringify({ schema: 1, entries }) : entries.map(entry => `${entry.name} ${entry.version} (${entry.license})\n\n${entry.text}`).join('\n\n---\n\n'));
    return EXIT.OK;
  } catch (error) {
    io.err(error instanceof Error ? error.message : 'Bundled notices could not be read.');
    return EXIT.REFUSED;
  }
}
