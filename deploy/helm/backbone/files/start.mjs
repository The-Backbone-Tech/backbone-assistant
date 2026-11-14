import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
if(process.env.BACKBONE_PLAINTEXT_TRIAL_ACK!=='I_ACCEPT_PLAINTEXT_KEYS_ON_THE_DATA_VOLUME')throw new Error('The plaintext trial requires acknowledgement.');
const endpoint=process.env.BACKBONE_MODEL_ENDPOINT;
if(endpoint){const url=new URL(endpoint);if(url.username||url.password||url.search||url.hash)throw new Error('Model endpoint credentials and query strings are refused.');}
const cli = 'packages/surfaces/cli/src/main.ts';
// First boot is an explicit creating command. Never reinitialize an existing home on upgrade.
if (!existsSync(`${process.env.BACKBONE_HOME}/core.json`)) {
  const result = spawnSync(process.execPath, [cli, 'projects', 'create', 'Fleet'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const child = spawn(process.execPath, [cli, 'daemon', 'run'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exit(1); });
child.on('exit', code => process.exit(code ?? 1));
