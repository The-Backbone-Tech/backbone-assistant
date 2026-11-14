import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

test('file access hint requires a structured denial, not answer or step text', async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { FileAccessHint } = await server.ssrLoadModule('/src/components/MacFileAccess.tsx');
    Object.assign(globalThis, { window: { backbone: { platform: 'darwin' } } });
    const render = (steps: unknown[], answer = '') => renderToStaticMarkup(createElement(FileAccessHint, { turn: { work: { steps }, answer: { text: answer, files: [] } } }));
    assert.equal(render([{ kind: 'note', label: 'Operation not permitted /' + 'Users/x/Downloads' }]), '');
    assert.equal(render([], 'Operation not permitted /' + 'Users/x/Downloads'), '');
    const html = render([{ kind: 'note', label: 'Work', denied: { kind: 'macos-protected-folder', folder: 'Downloads' } }]);
    assert.match(html, /macOS denied access to Downloads/);
    assert.match(html, /Allow Downloads/);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
    await server.close();
  }
});
