import { expect, test } from '@playwright/test';
import { freshDataHome } from '@backbone-next/platform/testing/data-home';
import { removeDataHome } from '@backbone-next/platform/composition';
import { startBridge, stopBridge } from './bridge';
import { api } from './journey';

test('a lost creation response is checked with the same identity against the real Host', async ({page}) => {
  const home=freshDataHome('project-create-recovery');const bridge=await startBridge(home);const keys:string[]=[];let lose=true;
  try {
    await page.goto(bridge.url);await expect(page.locator('[data-ready=true]')).toBeVisible();
    await page.route('**/api',async route=>{
      const request=route.request();const body=request.method()==='POST' ? request.postDataJSON() : null;
      if (body?.method==='projects.create') {keys.push(body.args.clientKey);if(lose){lose=false;await route.fetch();await route.abort();return;}}
      await route.continue();
    });
    await page.getByRole('button',{name:'New project'}).click();await page.getByRole('textbox',{name:'Name'}).fill('One durable project');
    await page.getByRole('button',{name:'Create project'}).click();await expect(page.getByRole('alert')).toContainText('could not be confirmed');
    const before=await api<{id:string;name:string}[]>(page,'projects.list',{});const made=before.filter(project=>project.name==='One durable project');expect(made).toHaveLength(1);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'New project'}).click();await page.getByRole('button',{name:'Check again'}).click();
    await expect(page.getByRole('dialog',{name:'New project'})).toHaveCount(0);expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);
    const after=await api<{id:string;name:string}[]>(page,'projects.list',{});expect(after.filter(project=>project.name==='One durable project')).toEqual(made);
  } finally {await page.close();await stopBridge(bridge.proc);await removeDataHome(home);}
});
