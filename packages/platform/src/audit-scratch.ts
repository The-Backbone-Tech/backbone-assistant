// One stable per-user scratch parent, also excluded by the ACP filesystem read profile.
// Computing the path does not create it or access the home, keys or database.
import {join} from 'node:path';
export const auditScratchParent = () => join(process.platform==='win32' ? process.env.TEMP! : '/tmp',`backbone-audit-${process.getuid?.()??'user'}`);
