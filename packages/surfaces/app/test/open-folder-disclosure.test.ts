import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

test('the launch button explains in-place updates and the recovery copy before launch',async()=>{
  // The override replays this assertion against a frozen renderer without changing source.
  const root=process.env.BACKBONE_OPEN_RESTORED_RENDERER_ROOT??fileURLToPath(new URL('..',import.meta.url));
  const server=await createServer({root,configFile:false,server:{middlewareMode:true},appType:'custom'});
  try{
    const {OpenFolderButton}=await server.ssrLoadModule('/src/components/settings/OpenDataFolder.tsx');
    const html=renderToStaticMarkup(createElement(OpenFolderButton,{id:'main-only-id'},'Open the restored folder'));
    assert.match(html,/upgraded in place/);assert.match(html,/verified export/);assert.match(html,/backups folder/);
    assert.match(html,/restore that export into a new folder/);assert.match(html,/older app does not undo/);
    assert.ok(html.indexOf('upgraded in place')<html.indexOf('Open the restored folder'));
  }finally{await server.close();}
});

test('a held command folder does not claim every background service keeps plaintext keys',async()=>{
  const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,server:{middlewareMode:true},appType:'custom'});
  try{
    const {HeldHome}=await server.ssrLoadModule('/src/components/HeldHome.tsx');
    const html=renderToStaticMarkup(createElement(HeldHome,{folder:'/data/Command work',status:{owns:false,heldBy:{kind:'daemon',pid:1234}}}));
    assert.match(html,/command line’s keys/);assert.match(html,/restore the export into a new data folder/);
    assert.doesNotMatch(html,/background service keeps this data folder/);
    assert.match(html,/Data folder: \/data\/Command work/);
  }finally{await server.close();}
});

test('a finished restore separates import completion from refusal to open',async()=>{
  const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,server:{middlewareMode:true},appType:'custom'});
  try{
    const {Finished}=await server.ssrLoadModule('/src/components/settings/RestoreBackup.tsx');
    const html=renderToStaticMarkup(createElement(Finished,{job:{state:'done',target:'/data/Restored',from:'/backup',finishedAt:'2026-11-14T00:00:00Z',counts:{},adds:{},skipped:[],openProblem:'Restored, but this app cannot open it from here: this data folder is incomplete.'}}));
    assert.match(html,/Restored into a new data folder/);assert.match(html,/Restored, but this app cannot open/);
    assert.doesNotMatch(html,/while the restored folder opens|Open the restored folder|may hold part of the backup|not known whether/);
  }finally{await server.close();}
});
