// Object names only. Canonical executable SQL remains in schema/, selected from the shipped baseline.
export const SIGNATURE_LEDGER_VERSION='connector-signature-ledger-v1';
export const SIGNATURE_FILES=['sec/t_connector_signature_terminal.sql','app/connector_signatures.sql','gov/give_connector_signature.sql',
  'gov/end_connector_signature.sql','gov/answer_decision_with_basis.sql',
  'gov/_settle_decision_with_basis.sql','gov/decision_answer_basis.sql'];
export const SIGNATURE_FUNCTIONS=['sec.t_connector_signature_terminal()','gov.give_connector_signature(uuid,text,text)',
  'gov.end_connector_signature(uuid,text)','gov.answer_decision_with_basis(uuid,text,text,text,jsonb)',
  'gov._settle_decision_with_basis(uuid,text,uuid,text,jsonb)','gov.decision_answer_basis(uuid)'];
export function assembleSignatureStep(blocks:readonly string[]):string {
  return ['SET LOCAL check_function_bodies=false;','SET LOCAL ROLE backbone_gov;',blocks[0],
    'RESET ROLE;','SET LOCAL ROLE backbone_owner;',blocks[1],
    'RESET ROLE;','SET LOCAL ROLE backbone_gov;',...blocks.slice(2),
    ...SIGNATURE_FUNCTIONS.filter(name=>name.startsWith('gov.')&&!name.startsWith('gov._')).map(name=>`GRANT EXECUTE ON FUNCTION ${name} TO backbone_app;`),
    'RESET ROLE;'].join('\n')+'\n';
}
