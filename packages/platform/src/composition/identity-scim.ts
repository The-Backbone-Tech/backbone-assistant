import { createHash, timingSafeEqual } from 'node:crypto';
import SCIMMY from 'scimmy';

export interface DirectoryPerson {
  id: string;
  userName: string;
  externalId?: string;
  displayName?: string;
  active: boolean;
}

/** Bound to ONE configured workspace/directory by trusted composition, never a request field.
 * Production implementation must use Core crossings, not an alternate authority store.
 * create must enforce unique userName/externalId, including removed identities.
 * update must lock, re-read, apply the callback and commit atomically. Deactivation must
 * revoke membership, sessions, mandates and running work before resolving. A failed or
 * unknown commit rejects; callers must inspect Core, never blindly resend a create. */
export interface IdentityDirectory {
  list(): Promise<DirectoryPerson[]>;
  /** Tombstone the resource and revoke access atomically; retain its unique binding. */
  remove(id:string):Promise<boolean>;
  get(id: string): Promise<DirectoryPerson | null>;
  create(person: Omit<DirectoryPerson, 'id'>): Promise<DirectoryPerson>;
  update(id: string, change: (current: DirectoryPerson) => Promise<DirectoryPerson>): Promise<DirectoryPerson | null>;
}

export class ScimRefusal extends Error {
  readonly status: number;
  constructor(status: number) { super('Directory request refused.'); this.status = status; }
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const USER = SCIMMY.Schemas.User.id, PATCH = SCIMMY.Messages.PatchOp.id;
const writable = new Set(['schemas', 'userName', 'externalId', 'displayName', 'active']);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/scim+json', 'cache-control': 'no-store' },
});
const wire = (person: DirectoryPerson) => new SCIMMY.Schemas.User({ ...person, schemas: [USER] }, 'out');

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/scim+json') throw new ScimRefusal(415);
  const reader = request.body?.getReader();
  if (!reader) throw new ScimRefusal(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new ScimRefusal(413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ScimRefusal(400); }
}

function personOf(body: Record<string, unknown>): Omit<DirectoryPerson, 'id'> {
  if (Object.keys(body).some(key => !writable.has(key))) throw new ScimRefusal(400);
  try {
    const person = new SCIMMY.Schemas.User(body, 'in');
    return { userName: person.userName, externalId: person.externalId, displayName: person.displayName, active: person.active ?? true };
  } catch { throw new ScimRefusal(400); }
}

/** Fetch handler only; not mounted by the personal Host. No global SCIMMY resource
 * registration: several workspaces must never overwrite each other's callbacks. */
export function createScimHandler(options: { bearer: string; directory: IdentityDirectory }): (request: Request) => Promise<Response> {
  if (Buffer.byteLength(options.bearer) < 32) throw new Error('A directory credential requires at least 32 bytes.');
  const expected = digest(options.bearer), directory = options.directory;
  return async request => {
    const authorization = request.headers.get('authorization') ?? '';
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization);
    if (!match || !timingSafeEqual(digest(match[1]), expected)) return json({ schemas: [SCIMMY.Messages.Error.id], status: '401' }, 401);
    try {
      const url = new URL(request.url), path = url.pathname;
      if ([...url.searchParams.keys()].some(key => !['filter', 'startIndex', 'count'].includes(key))) throw new ScimRefusal(400);
      if (path === '/scim/v2/ServiceProviderConfig' && request.method === 'GET') return json({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
        patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 100 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
        authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Directory bearer', description: 'Credential for one configured directory', primary: true }],
      });
      const route = /^\/scim\/v2\/Users(?:\/([A-Za-z0-9_-]+))?$/.exec(path);
      if (!route) throw new ScimRefusal(404);
      const id = route[1];
      if (request.method === 'GET') {
        if (id) { const found = await directory.get(id); if (!found) throw new ScimRefusal(404); return json(wire(found)); }
        let people = await directory.list();
        const filter = url.searchParams.get('filter');
        if (filter) {
          // Bound supported filters to identity lookup; no group/role interpretation.
          if (!/^(userName|externalId) eq "[^"\\]{1,512}"$/.test(filter)) throw new ScimRefusal(400);
          people = new SCIMMY.Types.Filter(filter).match(people);
        }
        const start = Number(url.searchParams.get('startIndex') ?? 1), count = Number(url.searchParams.get('count') ?? 100);
        if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 0 || count > 100) throw new ScimRefusal(400);
        return json({ schemas: [SCIMMY.Messages.ListResponse.id], totalResults: people.length, startIndex: start, itemsPerPage: Math.min(count, Math.max(0, people.length - start + 1)), Resources: people.slice(start - 1, start - 1 + count).map(wire) });
      }
      if (request.method === 'POST' && !id) return json(wire(await directory.create(personOf(await bodyOf(request)))), 201);
      if (!id || !['PUT', 'PATCH', 'DELETE'].includes(request.method)) throw new ScimRefusal(405);
      if(request.method==='DELETE'){
        if(!await directory.remove(id))throw new ScimRefusal(404);
        return new Response(null,{status:204,headers:{'cache-control':'no-store'}});
      }
      const body = await bodyOf(request);
      const updated = await directory.update(id, async current => {
        let next: DirectoryPerson;
        if (request.method === 'PUT') next = { ...personOf(body), id };
        else {
          try {
            if (Object.keys(body).some(key => !['schemas', 'Operations'].includes(key)) || !Array.isArray(body.Operations)) throw new Error();
            // Reject unsupported fields before SCIMMY can discard them; directory sync
            // cannot assign roles, change account binding, or mutate a workspace.
            for (const op of body.Operations) {
              if (!op || typeof op !== 'object' || Object.keys(op).some(key => !['op', 'path', 'value'].includes(key))) throw new Error();
              if (op.path ? !['displayName', 'active'].includes(op.path) : (!op.value || typeof op.value !== 'object' || Array.isArray(op.value) || Object.keys(op.value).some(key => !['displayName', 'active'].includes(key)))) throw new Error();
            }
            const patched = await new SCIMMY.Messages.PatchOp(body as unknown as ConstructorParameters<typeof SCIMMY.Messages.PatchOp>[0]).apply(wire(current));
            next = { ...current, displayName: patched.displayName, active: patched.active ?? current.active };
          } catch { throw new ScimRefusal(400); }
        }
        if (next.userName !== current.userName || next.externalId !== current.externalId || (!current.active && next.active)) throw new ScimRefusal(409);
        return next;
      });
      if (!updated) throw new ScimRefusal(404);
      return json(wire(updated));
    } catch (error) {
      const status = error instanceof ScimRefusal ? error.status : 503;
      return json({ schemas: [SCIMMY.Messages.Error.id], status: String(status), detail: status === 503 ? 'Directory outcome could not be confirmed. Inspect membership before retrying.' : 'Directory request refused.' }, status);
    }
  };
}
