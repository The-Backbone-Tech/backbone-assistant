// Shared helpers for the day-one checks: the tracked file list and small readers.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function listFiles(root) {
  if (!existsSync(join(root, '.git')) && existsSync(join(root, '.public-tree-files.json'))) {
    return JSON.parse(readFileSync(join(root, '.public-tree-files.json'), 'utf8')).files;
  }
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

export function read(root, file) {
  return readFileSync(join(root, file), 'utf8');
}

export function isText(file) {
  return !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf)$/i.test(file);
}

export const isTest = (file) => /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
