// Mailbox projects are made internally rather than through projects.create.
// Bind their native task before work so Core and Host share the same audience.
import type {CoreLink} from '../composition/core.ts';
type Prior={projectId:string;task:string};
export async function bindMailboxProject(link:CoreLink,projectId:string,task:string){
 if(link.identityStatus?.state!=='verified')return;
 await link.call(link.person(),'SELECT gov.identity_register_project($1)',[projectId]);
 await link.bindProjectTask(projectId,task);
}
export async function prepareMailboxProject(link:CoreLink,prior:Prior|null|undefined,name:string,project:(name:string)=>string|Promise<string>){
 const projectId=prior?.projectId??await project(name);
 const task=prior?.task??await link.call<string>(link.person(),'SELECT gov.create_task($1, $1, $2, NULL, NULL)',[link.id.person,'Mail triage']);
 await bindMailboxProject(link,projectId,task);
 return {projectId,task};
}
