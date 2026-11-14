// Child-only platform fault injection for the actual MCP CLI. No Core or provider is opened.
import {pathToFileURL} from 'node:url';
import {CoreCloseWaitRefusal,CoreLink} from '../src/composition/core.ts';
const [main,home,operation]=process.argv.slice(2);
let attempts=0;
CoreLink.open=async()=>{
  process.stderr.write(`synthetic-close-admission:${++attempts}\n`);
  throw new CoreCloseWaitRefusal(Promise.resolve());
};
process.argv=[process.execPath,main,operation,'--home',home,'--name','synthetic-closing-cli'];
await import(pathToFileURL(main).href);
