import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('a schedule made from the Scheduled page goes to the selected project, else the first', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { projectForNewSchedule } = await server.ssrLoadModule('/src/components/Scheduled.tsx');
    const projects = [{ id: 'a' }, { id: 'b' }];
    assert.equal(projectForNewSchedule(projects, 'b'), 'b');
    assert.equal(projectForNewSchedule(projects, 'gone'), 'a');
    assert.equal(projectForNewSchedule(projects, undefined), 'a');
    assert.equal(projectForNewSchedule([], 'a'), undefined);
  } finally {
    await server.close();
  }
});
