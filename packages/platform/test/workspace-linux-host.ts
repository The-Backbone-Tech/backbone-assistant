// Owned disposable Host process used only by the Linux interruption test.
import { WorkspaceStore } from '../src/workspace/store.ts';
const store = new WorkspaceStore('crash-owner', { root: process.argv[2] });
const prior = await store.run('thread', { command: 'echo durable > result', inputs: [] });
if (prior.code !== 0) throw new Error(JSON.stringify(prior));
process.send!('ready');
let finished: unknown;
try { finished = await store.run('thread', { command: `python3 - <<'PY'
import os,time,ctypes
if os.fork() == 0:
 os.setsid()
 if os.fork(): os._exit(0)
 os.environ.clear()
 ctypes.CDLL(None).prctl(4,0,0,0,0)
 open('ready','w').write(str(os.getpid()))
 time.sleep(100)
else:
 time.sleep(100)
PY`, inputs: [] });
} catch (error) { finished = { error: String(error) }; }
process.send!({ finished }, () => process.disconnect!());
