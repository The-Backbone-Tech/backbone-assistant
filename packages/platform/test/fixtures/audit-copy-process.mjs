import { exportAuditHome } from '../../src/composition/audit-home.ts';
const [home,root,point]=process.argv.slice(2);
try {
  await exportAuditHome(home,{since:'2000-01-01T00:00:00Z',until:'2100-01-01T00:00:00Z'}, async()=>{}, {
    temporaryRoot:root,atPoint:async(at,folder)=>{if(at===point){process.send({point:at,folder});await new Promise(()=>{});}}
  });
} catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
finally {if(process.connected)process.disconnect();}
