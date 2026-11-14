import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {dockerignoreText,excluded} from './lib/docker-context.mjs';

test('the daemon build includes the pinned Teams logger patch used by frozen installs',()=>{
 const root=join(import.meta.dirname,'..');
 const path='packages/surfaces/channels/patches/@chat-adapter__teams@4.44.0.patch';
 const workspace=readFileSync(join(root,'pnpm-workspace.yaml'),'utf8');
 assert.ok(workspace.includes(path));
 assert.ok(readFileSync(join(root,path),'utf8').includes('appLogger'));
 assert.equal(excluded(path,dockerignoreText(root)),false);
 assert.ok(readFileSync(join(root,'deploy/docker/Dockerfile'),'utf8').includes('COPY packages/surfaces/channels packages/surfaces/channels'));
});
