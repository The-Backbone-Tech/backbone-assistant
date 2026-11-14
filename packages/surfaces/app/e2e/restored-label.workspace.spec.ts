// Real export and restore into a fresh Host; only the historical labels are synthetic test data.
import { expect, test } from '@playwright/test';
import { createHost, hostClosed, removeDataHome } from '@backbone-next/platform/composition';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { MaterialStore } from '../../../platform/src/stub/material.ts';
import type { Method, Receipt } from '@backbone-next/platform';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const value = <T,>(r:Receipt<T>):T => {if(!r.ok) throw new Error(r.detail);return r.value;};
test('restored working versions display archive history without claiming current authorship', async ({page}) => {
  const sourceHome=freshDataHome('label-source'), targetHome=freshDataHome('label-restored');
  const exportRoot=mkdtempSync(join(tmpdir(),'label-export-'));
  const source=createHost({home:sourceHome}), target=createHost({home:targetHome});
  const pending=new Set<Promise<unknown>>();
  const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),server:{host:'127.0.0.1',port:0}});
  try {
    await server.listen();
    const project=value(await source.call('projects.create',{name:'Archive label',kind:'folder'}));
    const store=new MaterialStore(sourceHome,{},()=>{});
    const original=store.create(project.id,'history/working.md','text/markdown',Buffer.from('First'),'working','agent',undefined,'managed');
    value(await store.save(original.id,'Second',1,'person'));
    const exported=value(await source.call('backup.export',{to:join(exportRoot,'backup')}));
    await target.importExport(exported.folder);
    const restoredProject=(await target.call('projects.list',{})).find(p=>p.name==='Archive label')!;
    const entry=(await target.call('material.list',{projectId:restoredProject.id})).find(e=>e.name==='history/working.md')!;
    expect(entry.restored).toBe(true);expect(entry.versions.map(v=>v.by)).toEqual(['agent','person']);
    const prefs=await target.call('viewer.get',{});
    const show=async(version?:number)=>{await target.call('viewer.put',{prefs:{...prefs,selectedProjectId:restoredProject.id,pane:{open:true,tabs:[{id:'file',kind:'file',materialId:entry.id,...(version?{version}: {})}],active:'file'}}});};
    await show();
    await page.exposeFunction('restoredHostCall',async (method:Method,args:unknown)=>{const call=target.call(method,args as never);pending.add(call);try{return await call;}finally{pending.delete(call);}});
    await page.addInitScript(()=>{const w=window as any;w.backbone={platform:'linux',setTheme(){},onEvent(){return()=>{};},call:(method:string,args:unknown)=>w.restoredHostCall(method,args)};});
    await page.goto(server.resolvedUrls!.local[0]);
    for (const version of [undefined,1] as const) {
      if(version){await show(version);await page.reload();}
      await expect(page.getByRole('button',{name:'Document options',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Document options',exact:true}).click();
      await expect(page.getByTestId('file-version')).toHaveText(`v${version??2} · restored version`);
      await page.keyboard.press('Escape');
    }
  } finally {await page.close();while(pending.size)await Promise.allSettled([...pending]);source.close();target.close();await Promise.all([hostClosed(sourceHome),hostClosed(targetHome)]);await Promise.all([removeDataHome(sourceHome),removeDataHome(targetHome)]);await server.close();rmSync(exportRoot,{recursive:true,force:true});}
});
