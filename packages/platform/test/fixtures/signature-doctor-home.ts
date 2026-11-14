// Disposable released-schema home for CLI diagnostics; never remove a receipt from a current DB.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildBaseline,upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement} from '@backbone/core/db';
import {dataHomeAdminUrl} from '@backbone/core/testing';
import {legacyCoreDatabase} from './legacy-core.ts';
export async function prepareHomeWithoutSignatureStep(home: string) {
  const legacy=JSON.parse(readFileSync(new URL('./material-guard-legacy.json',import.meta.url),'utf8')).sqlLines.join('\n')+'\n';
  const admin=await legacyCoreDatabase(dataHomeAdminUrl(home),legacy);
  try {
    for(const upgrade of [upgradeMaterialGuard,upgradeMaterialLink,upgradeMaterialEnforcement]) {
      const status=await upgrade(admin,buildBaseline().sql);assert.equal(status.state,'verified',status.reason);
    }
    assert.equal((await admin.query("SELECT to_regprocedure('gov.give_connector_signature(uuid,text,text)') IS NULL AS absent")).rows[0].absent,true);
    return {
      snapshot: async()=>JSON.stringify((await admin.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(x) ORDER BY version) FROM ops.schema_migrations x) AS history,
        (SELECT jsonb_agg(to_jsonb(x) ORDER BY workspace_id,seq) FROM app.ledger x) AS ledger,
        (SELECT jsonb_agg(to_jsonb(x) ORDER BY workspace_id) FROM app.ledger_heads x) AS heads`)).rows),
      close: ()=>admin.end(),
    };
  }catch(error){await admin.end();throw error;}
}
