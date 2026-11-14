import { join } from 'node:path';
import { MaterialStore } from '../../src/stub/material.ts';

const [home, id] = process.argv.slice(2);
const store = new MaterialStore(home, { beforeFolderMove: () => { process.kill(process.pid, 'SIGKILL'); } }, () => {}, () => join(home, 'source.md'));
store.withdraw(id);
throw new Error('The metadata-before-projection crash point was not reached');
