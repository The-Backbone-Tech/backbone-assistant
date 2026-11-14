import {attachApi} from '../../src/doors/api-line.ts';
const line=await attachApi(process.argv[2]);
const result=await line.call('audit.export',{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'});
process.send(result);
setInterval(()=>{},1000);
