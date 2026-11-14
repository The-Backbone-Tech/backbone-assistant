// Child process for the personal-mode test: opens a host on a data home, waits until the core answers,
// and is killed outright with the home's database server still running, as a crash would leave it.
import { createHost } from '../src/composition/host.ts';

const [home] = process.argv.slice(2);
const host = createHost({ home });
const made = await host.call('projects.create', { name: 'Left running', kind: 'folder' });
if (!made.ok) throw new Error(made.detail);
console.log('ready');
process.kill(process.pid, 'SIGKILL');
