// Maintained browser automation through the actual Host and connector door, with local pages only.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { chromium, type BrowserContext } from 'playwright';
import { startScriptedModel, type Message, type Step } from '../src/testing/scripted-model.ts';
import { enableConnector } from '../src/testing/connectors.ts';
import { defaultToolEnv } from '../src/tools/places.ts';
import { CONNECTION_UNKNOWN } from '../src/connectors/service.ts';
import { freshDir, open, settings, value } from './helpers.ts';

async function browserWork(failure: 'transport' | 'action' | 'disabled' | 'reset') {
  const submissions: string[] = [];
  let ownedBrowser: BrowserContext | undefined;
  let clientKey = '';
  let uncertain = false;
  const site = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/submit') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        submissions.push(body);
        if (!uncertain) response.end('<h1>Recorded</h1>');
        // Close the actual page only after the POST arrived, while its click still awaits navigation.
        else if (failure === 'reset') void ownedBrowser!.pages()[0].close().catch(() => {});
      });
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<h1>Local catalogue</h1><p>Amber service costs 12 credits.</p><form method="post" action="/submit"><label>Name <input name="name"></label><button type="submit" ${uncertain && failure === 'disabled' ? 'disabled' : ''}>Submit request</button></form>`);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const words = (message: Message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  const script = (messages: Message[]): Step => {
    const results = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1).filter(message => message.role === 'tool');
    const call = (tool: string, args: Record<string, unknown>): Step => ({ calls: [{ name: `mcp__browser__${tool}`, args }] });
    switch (results.length) {
      case 0: return call('browser_navigate', { url });
      case 1: return call('browser_snapshot', {});
      case 2: {
        const snapshot = words(results[1]);
        assert.match(snapshot, /Amber service costs 12 credits/);
        const ref = /textbox "Name" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];
        assert.ok(ref, snapshot);
        return call('browser_fill_form', { fields: [{ name: 'Name', type: 'textbox', target: ref, value: 'Ada' }] });
      }
      case 3: return call('browser_snapshot', {});
      case 4: {
        const snapshot = words(results[3]);
        assert.match(snapshot, /Ada/, `Filling must change the page: ${words(results[2])}`);
        const ref = /button "Submit request"[^\n]*\[ref=([^\]]+)\]/.exec(snapshot)?.[1];
        assert.ok(ref, snapshot);
        // Change only the human-readable description on the later call. This reaches the scoped
        // tool pause rather than Core's earlier guard against an identical unknown statement.
        return call('browser_click', { element: clientKey === 'after-unknown' ? 'Submit request, later independent request' : 'Submit request', target: ref });
      }
      case 5: {
        // A plausible model retries a reported tool failure. A truthful UNKNOWN must stop this
        // continuation before it can ask for a second submission in the same turn.
        if (failure !== 'transport') {
          const ref = /button "Submit request"[^\n]*\[ref=([^\]]+)\]/.exec(words(results[3]))?.[1];
          assert.ok(ref);
          return call('browser_click', { element: 'Submit request', target: ref });
        }
        return { text: `Looked up the 12-credit service and filled Ada. Submission result: ${words(results.at(-1)!)}` };
      }
      default: return { text: `Looked up the 12-credit service and filled Ada. Submission result: ${words(results.at(-1)!)}` };
    }
  };
  const model = await startScriptedModel('browser-model', script);
  const oldEndpoint = process.env.BACKBONE_MODEL_ENDPOINT, oldModel = process.env.BACKBONE_MODEL_ID;
  process.env.BACKBONE_MODEL_ENDPOINT = model.url; process.env.BACKBONE_MODEL_ID = model.model;
  try {
    const person = freshDir('browser-person-');
    const cli = join(dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')), 'cli.js');
    const browserTimeout = failure === 'transport' ? '30000' : '2000';
    let launch = ['--headless', '--isolated', '--executable-path', chromium.executablePath()];
    if (failure === 'reset') {
      const profile = freshDir('browser-owned-cdp-');
      ownedBrowser = await chromium.launchPersistentContext(profile, { headless: true, args: ['--remote-debugging-port=0'] });
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      launch = ['--cdp-endpoint', `http://127.0.0.1:${port}`];
    }
    writeFileSync(join(person, '.claude.json'), JSON.stringify({ mcpServers: { browser: { command: process.execPath, args: [cli, ...launch, '--no-webmcp', '--timeout-action', browserTimeout, '--timeout-navigation', browserTimeout, '--block-service-workers', '--output-dir', join(person, 'output')] } } }));
    const { host } = open(undefined, { harness: 'harness-pi', connectors: { env: defaultToolEnv({ HOME: person, PATH: process.env.PATH }), sources: ['claude-code'], callTimeoutMs: 5000 } });
    const serverId = 'claude-code:browser';
    value(await host.call('connectors.refresh', { serverId }));
    value(await enableConnector(host, serverId));
    for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_fill_form', 'browser_click']) value(await enableConnector(host, serverId, tool));
    value(await host.openConnectorDoor(serverId, host.connectorDoorSeal(serverId)!));
    const sign = async (tool: string) => {
      const shown = host.connectorToolView(serverId, tool)!;
      value(await host.signConnectorTool(serverId, tool, shown.seal, shown.stamp, false));
    };
    await sign('browser_navigate'); await sign('browser_fill_form');
    const project = value(await host.call('projects.create', { name: 'Browser work', kind: 'folder' }));
    const run = async (key: string) => {
      clientKey = key;
      const sent = value(await host.call('turns.send', { projectId: project.id, text: 'Look up the service, fill Ada and submit the request.', attachments: [], settings, clientKey: key }));
      for (let i = 0; i < 600; i++) {
        const thread = value(await host.call('threads.get', { id: sent.threadId }));
        if (!thread.summary.running) return thread.turns[0];
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Browser turn did not settle.');
    };
    const held = await run('unsigned-submit');
    assert.equal(held.status, 'done');
    assert.match(held.answer?.text ?? '', /Held for the person/);
    assert.deepEqual(submissions, [], 'filling fields cannot submit the unsigned form');
    await sign('browser_click');
    if (failure !== 'disabled') {
      const sent = await run('signed-submit');
      assert.equal(sent.status, 'done');
      assert.deepEqual(submissions, ['name=Ada']);
    }
    const receipts = (await host.call('connectors.list', {})).held;
    if (failure !== 'disabled') assert.ok(receipts.some(receipt => receipt.tool === 'browser_click' && receipt.state === 'sent' && receipt.standing), 'the submission crossed the existing door on its standing grant');
    const knownCalls = new Set(receipts.map(receipt => receipt.effect));
    uncertain = true;
    const beforeUncertain = model.requests.length;
    const unknown = await run('uncertain-submit');
    const expectedSubmissions = failure === 'disabled' ? [] : ['name=Ada', 'name=Ada'];
    assert.deepEqual(submissions, expectedSubmissions);
    const newestClick = (await host.call('connectors.list', {})).held.find(receipt => receipt.tool === 'browser_click' && !knownCalls.has(receipt.effect));
    assert.equal(newestClick?.state, 'unknown', 'an action error cannot establish whether submission happened');
    if (failure === 'reset') assert.match(newestClick.detail, /returned an error/, 'a non-timeout error reply after page closure must remain UNKNOWN');
    assert.equal(unknown.status, 'stopped', 'a browser error after the POST arrived does not prove the submission failed');
    assert.ok(model.requests.slice(beforeUncertain).every(recorded => JSON.parse(recorded.body).messages.filter((message: Message) => message.role === 'tool').length < 5), 'the uncertain submission cannot reach another model continuation');
    assert.ok((await host.call('connectors.list', {})).held.some(receipt => receipt.tool === 'browser_click' && receipt.state === 'unknown'));
    assert.match(unknown.answer?.text ?? '', /UNKNOWN/);
    const beforePaused = new Set((await host.call('connectors.list', {})).held.map(receipt => receipt.effect));
    const afterUnknown = await run('after-unknown');
    assert.ok(afterUnknown.status !== 'running');
    const paused = (await host.call('connectors.list', {})).held.filter(receipt => !beforePaused.has(receipt.effect));
    const pausedClick = paused.find(receipt => receipt.tool === 'browser_click');
    assert.ok(pausedClick, `the later turn must reach the paused click: ${JSON.stringify({ status: afterUnknown.status, answer: afterUnknown.answer, paused })}`);
    assert.equal(pausedClick.state, 'waiting');
    assert.equal(pausedClick.standing, undefined);
    assert.equal(pausedClick.detail, CONNECTION_UNKNOWN);
    for (const tool of ['browser_navigate', 'browser_fill_form']) assert.ok(paused.some(receipt => receipt.tool === tool && receipt.state === 'sent' && receipt.standing), `${tool} on the same connection still runs`);
    assert.deepEqual(submissions, expectedSubmissions, 'the uncertain submission is never dispatched again');
  } finally {
    if (oldEndpoint === undefined) delete process.env.BACKBONE_MODEL_ENDPOINT; else process.env.BACKBONE_MODEL_ENDPOINT = oldEndpoint;
    if (oldModel === undefined) delete process.env.BACKBONE_MODEL_ID; else process.env.BACKBONE_MODEL_ID = oldModel;
    await ownedBrowser?.close(); await model.close(); site.closeAllConnections(); await new Promise<void>(resolve => site.close(() => resolve()));
  }
}

test('a person looks up a page and fills a form with Playwright; signed submission has a receipt and UNKNOWN is never resent', { timeout: 90_000 }, () => browserWork('transport'));
test('a browser action timeout after a delivered submission remains UNKNOWN instead of a retryable failure', { timeout: 90_000 }, () => browserWork('action'));
test('a disabled submit button times out before delivery with zero submissions and a scoped UNKNOWN pause', { timeout: 90_000 }, () => browserWork('disabled'));
test('a page closed after the submission arrived remains UNKNOWN and blocks a second click', { timeout: 90_000 }, () => browserWork('reset'));
