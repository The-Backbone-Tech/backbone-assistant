import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareReservedProject } from '../src/composition/project-create-prepare.ts';
import type { ProjectIntent } from '../src/composition/project-create-intent.ts';

function attempt(kind:'folder'|'git', dir:string):ProjectIntent { return {key:'key',name:'Example',kind,phase:'started',project:{id:'project-id',name:'Example',kind,createdAt:'now',dir}}; }
test('preparation refuses occupied paths and does not touch their contents or symlink targets', () => {
  const home=mkdtempSync(join(tmpdir(),'project-prepare-')); try {
    mkdirSync(join(home,'projects')); const existing=join(home,'projects','existing'); mkdirSync(existing); writeFileSync(join(existing,'README.md'),'human');
    assert.throws(()=>prepareReservedProject(home,attempt('git','existing')));
    assert.equal(readFileSync(join(existing,'README.md'),'utf8'),'human');
    const target=join(home,'target'); mkdirSync(target); writeFileSync(join(target,'README.md'),'target'); symlinkSync(target,join(home,'projects','link'));
    assert.throws(()=>prepareReservedProject(home,attempt('git','link'))); assert.equal(readFileSync(join(target,'README.md'),'utf8'),'target');
  } finally {rmSync(home,{recursive:true,force:true});}
});
test('new Git preparation commits only the explicitly created README', () => {
  const home=mkdtempSync(join(tmpdir(),'project-prepare-')); try {
    prepareReservedProject(home,attempt('git','new')); const dir=join(home,'projects','new');
    assert.equal(readFileSync(join(dir,'README.md'),'utf8'),'# Example\n');
    const tracked=execFileSync('git',['ls-files'],{cwd:dir,encoding:'utf8'}).trim().split('\n'); assert.deepEqual(tracked,['README.md']);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('a symlinked projects root is refused without writing through it', () => {
  const home=mkdtempSync(join(tmpdir(),'project-root-link-')); try {
    const target=join(home,'other');mkdirSync(target);symlinkSync(target,join(home,'projects'));
    assert.throws(()=>prepareReservedProject(home,attempt('git','new')));
    assert.equal(readdirSync(target).length,0);
  } finally {rmSync(home,{recursive:true,force:true});}
});

test('Git preparation ignores user hooks, templates, and global signing or fsmonitor configuration', () => {
  const home=mkdtempSync(join(tmpdir(),'project-git-isolation-'));const old={...process.env};
  try {
    const config=join(home,'user'); const template=join(home,'template');const marker=join(home,'executed');mkdirSync(config);mkdirSync(join(template,'hooks'),{recursive:true});
    const hook=join(template,'hooks','pre-commit');writeFileSync(hook,`#!/bin/sh\ntouch '${marker}'\n`);chmodSync(hook,0o755);
    writeFileSync(join(config,'.gitconfig'),`[commit]\n  gpgsign = true\n[core]\n  fsmonitor = touch ${marker}\n`);
    process.env.HOME=config;process.env.XDG_CONFIG_HOME=config;process.env.GIT_TEMPLATE_DIR=template;
    prepareReservedProject(home,attempt('git','isolated'));
    assert.equal(existsSync(marker),false);
  } finally {process.env=old;rmSync(home,{recursive:true,force:true});}
});


test('Git preparation kills a stuck invocation within five seconds', () => {
  const home=mkdtempSync(join(tmpdir(),'project-git-timeout-')), oldPath=process.env.PATH;
  try {
    const bin=join(home,'bin');mkdirSync(bin);
    writeFileSync(join(bin,'git'),`#!${process.execPath}\nprocess.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),8_000);\n`);chmodSync(join(bin,'git'),0o755);
    process.env.PATH=bin;
    const started=Date.now();
    assert.throws(()=>prepareReservedProject(home,attempt('git','stuck'),()=>{},1_000), /ETIMEDOUT/);
    assert.ok(Date.now()-started<5_000,'a git process that ignores TERM cannot block the host');
    assert.equal(existsSync(join(home,'projects','stuck','README.md')),true);
  } finally {process.env.PATH=oldPath;rmSync(home,{recursive:true,force:true});}
});
