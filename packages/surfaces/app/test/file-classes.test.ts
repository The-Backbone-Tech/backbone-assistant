import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileClassLabel, reviewFiles } from '../src/lib/file-classes.ts';
import type { ProjectFile } from '@backbone-next/platform';

test('Files shows unregistered folder/git paths with an attach explanation and excludes them from Review', () => {
  const files: ProjectFile[] = [{ path: 'src/index.ts', class: 'unregistered' }, { path: 'sales.csv', class: 'unregistered' }, { path: 'brief.md', class: 'working', materialId: 'brief' }, { path: 'source.csv', class: 'original', materialId: 'source' }];
  assert.match(fileClassLabel('unregistered'), /Unregistered.*not given to the engine.*attach/i);
  assert.deepEqual(reviewFiles(files).map(f => f.path), ['brief.md']);
  assert.deepEqual(files.map(f => f.path), ['src/index.ts', 'sales.csv', 'brief.md', 'source.csv']);
});
