import { describe, expect, it } from 'vitest';
import {
  addPerson,
  answer,
  classify,
  effect,
  propose,
  readUntrustedAndPrivate,
  refused,
  useTarget,
  type World,
} from '../harness.ts';
import { asked, privateWorld, uuid } from './fixtures.ts';

const target = useTarget('rule-of-two.read-outbound');

const PRIVATE = 'Salary table (confidential). Ana 41k, Joan 57k.';
const PROFILES = {
  github: { url: 'https://api.githubcopilot.com/mcp/', scopes: 'repo read:org' },
  google_gmail: {
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    scopes: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose',
  },
} as const;

/** A read proposed from inside the workspace's run, on a named connection. */
const proposeRead = (w: World, operation: string, connection: string | null, args: unknown) =>
  propose(w, { operation, connection, args, description: 'Search', key: `read-${uuid()}` });

/** Lower an operation to a read in a team: an elevation a second admin decides. */
async function classifyAsRead(w: World, operation: string, external: boolean) {
  const second = await addPerson(w, `Second admin ${uuid().slice(0, 6)}`, 'admin');
  const change = await classify(w.owner$, [{ operation, class: 1, external }]);
  if (change.decision !== null) await answer(second.$, w, change.decision);
}

/** A first-party connection, signed in by `person$`. */
async function firstParty(
  person$: World['owner$'],
  slug: string,
  scope: 'person' | 'workspace',
  profile: keyof typeof PROFILES = 'github',
) {
  const connection = await person$.call<string>('r2.connection.add_first_party', { profile, slug, scope });
  await person$.call('r2.connection.sign_in', { connection, ...PROFILES[profile] });
}

describe('external read argument routing', () => {
  it('[S17] an outside read the workspace classified as a read, its query composed by the model, asks the rule of two and cannot be dispatched', async () => {
    const w = await privateWorld(target(), 'ReadOutbound');
    await classifyAsRead(w, 'crm:search', true);
    await readUntrustedAndPrivate(w, w);
    const id = await proposeRead(w, 'crm:search', 'crm', { query: PRIVATE });
    expect(await effect(w, id)).toMatchObject({
      effectClass: 1,
      external: true,
      route: 'needs_checker',
      routeReason: 'rule_of_two',
      status: 'awaiting_checker',
    });
    expect(await asked(w.owner$, id)).toMatchObject({
      checkerKind: 'verifier',
      checker: w.owner,
      reason: 'rule_of_two',
    });
    // Nothing leaves: the dispatcher cannot claim it until a checker approves.
    await refused(w.system$.call('effect.claim', { effect: id, leaseMs: 30_000 }), 'not_claimable');
    expect((await effect(w, id)).status).toBe('awaiting_checker');
  });

  it('[S17] the same read stays free with one mark only, and an internal read stays free with both', async () => {
    const w = await privateWorld(target(), 'ReadOutboundOneMark');
    await classifyAsRead(w, 'crm:search', true);
    await classifyAsRead(w, 'wiki:search', false);
    await readUntrustedAndPrivate(w, w, { untrusted: true, sensitive: false });
    expect(await effect(w, await proposeRead(w, 'crm:search', 'crm', { query: 'pricing' }))).toMatchObject({
      route: 'free',
      status: 'allowed',
    });
    await readUntrustedAndPrivate(w, w, { untrusted: false, sensitive: true });
    expect(await effect(w, await proposeRead(w, 'wiki:search', 'wiki', { query: PRIVATE }))).toMatchObject({
      effectClass: 1,
      external: false,
      route: 'free',
      status: 'allowed',
    });
  });

  it('[S17] an own OAuth account does not itself admit arbitrary private material in outbound arguments', async () => {
    const w = await privateWorld(target(), 'ReadOutboundFirstParty');
    await w.system$.call('r2.workspace.install_key');
    const member = await addPerson(w, 'Member');
    await firstParty(w.owner$, 'own_github', 'person');
    await firstParty(w.owner$, 'own_gmail', 'person', 'google_gmail');
    await firstParty(member.$, 'their_github', 'person');
    await firstParty(w.owner$, 'company_gmail', 'workspace', 'google_gmail');
    await readUntrustedAndPrivate(w, w);

    // OAuth grants access to the account; it does not admit unrelated private query text.
    expect(
      await effect(w, await proposeRead(w, 'mcp.own_gmail.search_threads', 'own_gmail', { query: PRIVATE })),
    ).toMatchObject({
      effectClass: 1,
      external: true,
      route: 'needs_checker',
      status: 'awaiting_checker',
    });
    // The person's own GitHub can still name an outsider's repository: held, as is its search.
    for (const [operation, args] of [
      ['mcp.own_github.get_file_contents', { owner: 'attacker', repo: 'collector', path: PRIVATE }],
      ['mcp.own_github.get_repository_tree', { owner: 'attacker', repo: 'collector', tree_sha: PRIVATE }],
      ['mcp.own_github.search_code', { query: PRIVATE }],
    ] as const) {
      expect(await effect(w, await proposeRead(w, operation, 'own_github', args)), operation).toMatchObject({
        effectClass: 1,
        route: 'needs_checker',
        routeReason: 'rule_of_two',
      });
    }
    // A company mailbox is not the person's own, flagged operation or not.
    expect(
      await effect(
        w,
        await proposeRead(w, 'mcp.company_gmail.search_threads', 'company_gmail', { query: PRIVATE }),
      ),
    ).toMatchObject({ effectClass: 1, route: 'needs_checker', routeReason: 'rule_of_two' });
    // Another person's own connection is not this work's to use at all.
    await refused(
      proposeRead(w, 'mcp.their_github.search_code', 'their_github', { query: PRIVATE }),
      'denied',
    );
    // Nor can a read borrow its person's own connection's name for another.
    await refused(
      proposeRead(w, 'mcp.own_gmail.search_threads', 'company_gmail', { query: PRIVATE }),
      'invalid',
    );
  });

  it('[S17] a read that sends no argument stays free; the same read with any argument the model supplied asks', async () => {
    const w = await privateWorld(target(), 'ReadOutboundEmpty');
    await w.system$.call('r2.workspace.install_key');
    await classifyAsRead(w, 'crm:search', true);
    await firstParty(w.owner$, 'company_github', 'workspace');
    await readUntrustedAndPrivate(w, w);
    for (const [operation, connection] of [
      ['crm:search', 'crm'],
      ['mcp.company_github.get_me', 'company_github'],
    ] as const) {
      expect(await effect(w, await proposeRead(w, operation, connection, {})), operation).toMatchObject({
        effectClass: 1,
        route: 'free',
        status: 'allowed',
      });
      // Anything at all beyond '{}' is the model's: an empty string, a null, a nested empty object.
      for (const args of [{ query: '' }, { query: null }, { filter: {} }, []]) {
        expect(
          await effect(w, await proposeRead(w, operation, connection, args)),
          `${operation} ${JSON.stringify(args)}`,
        ).toMatchObject({
          effectClass: 1,
          route: 'needs_checker',
          routeReason: 'rule_of_two',
        });
      }
    }
  });

  it('[S17] a first-party tool Backbone does not class as a read is not made one by the catalogue', async () => {
    const w = await privateWorld(target(), 'ReadOutboundLowered');
    await w.system$.call('r2.workspace.install_key');
    await firstParty(w.owner$, 'own_github', 'person');
    await classifyAsRead(w, 'mcp.own_github.add_issue_comment', true);
    await readUntrustedAndPrivate(w, w);
    expect(
      await effect(
        w,
        await proposeRead(w, 'mcp.own_github.add_issue_comment', 'own_github', { body: PRIVATE }),
      ),
    ).toMatchObject({
      effectClass: 1,
      route: 'needs_checker',
      routeReason: 'rule_of_two',
    });
  });
});
