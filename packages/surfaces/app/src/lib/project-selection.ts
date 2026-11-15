import type {ViewerPrefs} from '@backbone-next/platform';

/** An archive response may arrive after the person has already selected other work. */
export function projectArchiveSelection(prefs:ViewerPrefs,id:string,projects:readonly {id:string;archived?:boolean}[]):ViewerPrefs {
  if(prefs.selectedProjectId!==id||prefs.selectedThreadId)return prefs;
  return {...prefs,view:undefined,selectedProjectId:projects.find(project=>project.id!==id&&!project.archived)?.id,selectedThreadId:undefined};
}

/** A refresh can repair a transition without closing a deliberately opened archived conversation. */
export function projectRefreshSelection(prefs:ViewerPrefs,before:readonly {id:string;archived?:boolean}[]|undefined,projects:readonly {id:string;archived?:boolean}[]):ViewerPrefs {
  const selected=prefs.selectedProjectId;
  if(prefs.selectedThreadId||!selected||!projects.some(project=>project.id===selected&&project.archived)||(before!==undefined&&!before.some(project=>project.id===selected&&!project.archived)))return prefs;
  return projectArchiveSelection(prefs,selected,projects);
}
