import {MATERIAL_CLOSURE_RELEASE as currentDevice} from './identity-device-current-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as nativeTurn} from './identity-native-turn-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as subject} from './identity-device-subject-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as lockout} from './identity-device-lockout-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as recovery} from './identity-device-recovery-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as invitations} from './identity-invitation-closure-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as lookups} from './identity-lookup-closure-release.generated.ts';
import {MATERIAL_CLOSURE_RELEASE as piece} from './identity-piece-admission-release.generated.ts';
// Closed hardening releases extend the exact platform predecessor in source order.
import {createHash} from 'node:crypto';
import {MATERIAL_CLOSURE_RELEASE as roles} from './identity-role-closure-release.generated.ts';
import {IDENTITY_HARDENING_PINS} from './identity-hardening-pins.ts';
import {IDENTITY_PLATFORM_PINS} from './identity-platform-pins.ts';
import {CORE_SCHEMA_UPGRADES} from './schema-migrations.ts';
export const IDENTITY_HARDENING_RELEASES = [roles,piece,lookups,invitations,recovery,lockout,subject,nativeTurn,currentDevice];
export function hardeningCatalogue(catalogue:string):boolean {
 let predecessor=IDENTITY_PLATFORM_PINS?.catalogue;
 for(const [index,release] of IDENTITY_HARDENING_RELEASES.entries()){
  const pin=IDENTITY_HARDENING_PINS[index];
  if(!pin||pin.version!==release.version||pin.predecessor!==predecessor||pin.payload!==release.checksum
   ||createHash('sha256').update(release.sql).digest('hex')!==pin.payload
   ||CORE_SCHEMA_UPGRADES.find(row=>row.version===release.version)?.checksum!==pin.payload)return false;
  if(pin.catalogue===catalogue)return true;
  predecessor=pin.catalogue;
 }
 return false;
}
