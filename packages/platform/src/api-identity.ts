import type { Receipt } from './api.ts';

export type PersonRole = 'owner' | 'admin' | 'member' | 'guest';
export type ProjectAccess = 'owner' | 'editor' | 'viewer';
export interface WorkspacePerson { id: string; name: string; role: PersonRole; status: 'active' | 'removed' }
export interface IdentityView { person: WorkspacePerson; people: WorkspacePerson[]; deviceOwner: boolean; recoveries?: {person:string;at:string}[] }
export interface AutomationIdentity { id: string; name: string; person: string; project: string; mandate: string; piece: string | null; revoked: boolean }
export interface IdentityMethods {
  'identity.get': (args: Record<string, never>) => Receipt<IdentityView>;
  'identity.invite': (args: { role: Exclude<PersonRole, 'owner'> }) => Receipt<{ token: string; expiresAt: string }>;
  'identity.role': (args: { personId: string; role: PersonRole }) => Receipt<{ changed: true }>;
  'identity.remove': (args: { personId: string }) => Receipt<{ removed: true }>;
  'identity.share': (args: { projectId: string; personId: string; access: Exclude<ProjectAccess, 'owner'> | null }) => Receipt<{ shared: true }>;
  'identity.sharing': (args: { projectId: string }) => Receipt<{ access: ProjectAccess; nativeAccountTools?: boolean; people: WorkspacePerson[]; grants: {person:string;access:Exclude<ProjectAccess,'owner'>}[] }>;
  'identity.automations': (args: Record<string, never>) => Receipt<AutomationIdentity[]>;
  'identity.automation.create': (args: { personId: string; projectId: string; name: string }) => Receipt<{ id: string }>;
  'identity.automation.revoke': (args: { id: string }) => Receipt<{ revoked: true }>;
  'identity.automation.run': (args: { id: string; text: string }) => Receipt<{ threadId: string; turnId: string }>;
}
