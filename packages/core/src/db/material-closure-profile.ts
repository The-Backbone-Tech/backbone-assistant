// Catalogue-only attestation. History, installer locking, current authority and activation
// belong to their own owners. Expected data is compiled, never learned from an inspected home.
import {createHash} from 'node:crypto';
import type pg from 'pg';
import {INHERITED} from './material-closure-inherited.ts';
import {collectGuard,collectLink,collectEnforcement,type FunctionRow,type TriggerRow} from './material-closure-inherited-catalogue.ts';
import {collectMaterialClosureCatalogue,type ObjectRow} from './material-closure-catalogue.ts';
import {MATERIAL_CLOSURE_PINS,type ClosureCataloguePins,type MaterialClosurePins} from './material-closure-pins.ts';
import {MATERIAL_CLOSURE_RELEASE} from './material-closure-release.generated.ts';
import {FUNCTIONS,BASE_FUNCTIONS,ADDED_FUNCTIONS,CRYPTO_FUNCTIONS,RELATIONS,BASE_RELATIONS,SCHEMAS} from './material-closure-scope.ts';

export const closureHash=(s:string)=>createHash('sha256').update(s).digest('hex');
const cOrder=(a:string,b:string)=>Buffer.compare(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));
export function closureCanonical(v:unknown):string {
 if(v===null||typeof v!=='object')return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(closureCanonical).join(',')+']';
 return '{'+Object.keys(v).sort(cOrder).map(k=>JSON.stringify(k)+':'+closureCanonical((v as Record<string,unknown>)[k])).join(',')+'}';
}
export const closureNativeHash=(row:FunctionRow)=>closureHash(closureCanonical({...row,body:row.body===null?null:closureHash(row.body)}));
class ProfileMismatch extends Error {}
function required(value:unknown,message:string):asserts value {if(!value)throw new ProfileMismatch(message);}
function exactKeys(actual:readonly string[],expected:readonly string[],label:string):void {
 required(new Set(actual).size===actual.length&&new Set(expected).size===expected.length,'Duplicate '+label);
 required(closureCanonical([...actual].sort(cOrder))===closureCanonical([...expected].sort(cOrder)),'Incomplete '+label);
}
function ordered(rows:readonly ObjectRow[],label:string):void {
 exactKeys(rows.map(x=>JSON.stringify([x.kind,x.name])),rows.map(x=>JSON.stringify([x.kind,x.name])),label);
 for(let i=1;i<rows.length;i++)required(cOrder(rows[i-1].kind,rows[i].kind)<0||rows[i-1].kind===rows[i].kind&&cOrder(rows[i-1].name,rows[i].name)<0,'Unordered '+label);
}
const sha=(s:string)=>/^[a-f0-9]{64}$/.test(s);
type NativeSpec=(typeof INHERITED.nativeSpecs)[keyof typeof INHERITED.nativeSpecs];

/** Retain all 21 released prosrc and native-structure assertions, except the explicitly
 * versioned source-state replacement whose complete new native row is independently pinned. */
function inheritedNativeMatches(row:FunctionRow,pin:NativeSpec):boolean {
 if(row.body===null||closureHash(row.body)!==pin.body||row.kind!=='f'||row.support!==false||row.sqlBody!==false
  ||row.language!==pin.language||row.owner!=='backbone_gov'||row.definer!==pin.definer
  ||row.volatility!==pin.volatility||row.result!==pin.result||row.set!==pin.set
  ||row.strict!==false||row.leakproof!==false||row.parallel!==pin.parallel
  ||row.defaults!==pin.defaults||row.defaultExpression!==pin.defaultExpression||row.variadic!==false
  ||closureCanonical(row.argumentNames)!==closureCanonical(pin.argumentNames)||closureCanonical(row.argumentModes)!==closureCanonical(pin.argumentModes)
  ||closureCanonical(row.allArgumentTypes)!==closureCanonical(pin.allArgumentTypes)
  ||closureCanonical(row.configuration)!==closureCanonical(['search_path=pg_catalog'])
  ||row.appExecutes!==pin.app||row.operatorExecutes!==false||row.ownerExecutes!==pin.ownerExecute)return false;
 const grantees=['backbone_gov',...(pin.app?['backbone_app']:[]),...(pin.ownerExecute?['backbone_owner']:[])];
 return Array.isArray(row.acl)&&row.acl.length===grantees.length&&new Set(row.acl.map(x=>x.grantee)).size===grantees.length
  &&row.acl.every(x=>grantees.includes(x.grantee)&&x.grantor==='backbone_gov'&&x.privilege==='EXECUTE'&&x.grantable===false);
}
function receiptTriggerMatches(t:TriggerRow):boolean {
 return t.name==='episodes.material_source_receipt'&&t.enabled==='A'&&t.type===5
  &&t.function==='sec.t_material_episode_source()'&&t.constraint===true&&t.constraintType==='t'
  &&t.constraintTable===true&&t.constraintDeferrable===true&&t.constraintDeferred===true
  &&t.deferrable===true&&t.deferred===true&&t.validated===true&&t.predicate===null
  &&t.arguments===0&&t.argumentBytes===0&&t.updateColumns===0&&t.oldTable===null&&t.newTable===null
  &&t.constraintRelation===null&&t.parent===0;
}

/** Exported for the offline source-pins generator and native controls. Captures facts only;
 * never grants a capability or stores an expected profile. Callers own schema/DDL coherence. */
export async function captureMaterialClosureProfile(client:pg.ClientBase){
 const guard=await collectGuard(client),link=await collectLink(client),enforcement=await collectEnforcement(client);
 const full=await collectMaterialClosureCatalogue(client);
 return {guard,link,enforcement,full};
}
export type MaterialClosureCapture=Awaited<ReturnType<typeof captureMaterialClosureProfile>>;

/** All independent historical observations keep their original encodings and scopes. */
export function assertInheritedMaterialProfile(actual:MaterialClosureCapture,phase:'prerequisite'|'current',pins?:MaterialClosurePins,replacements:ReadonlySet<string>=new Set()):void {
 const {guard,link,enforcement}=actual;
 exactKeys([...new Set([...INHERITED.definitionClaims.map(x=>x.signature),...Object.keys(INHERITED.nativeSpecs)])],INHERITED.signatures,'inherited59 signatures');
 for(const family of ['guard','link'] as const){
  const rows=family==='guard'?guard.functions:link.functions,wanted=INHERITED.definitionClaims.filter(x=>x.family===family);
  exactKeys(Object.keys(rows),wanted.map(x=>x.signature),family+' definition claims');
  for(const claim of wanted)if(!replacements.has(claim.signature))required(rows[claim.signature]===claim.hash,'Changed inherited '+family+' definition');
 }
 exactKeys(enforcement.functions.map(x=>x.signature),Object.keys(INHERITED.nativeSpecs),'inherited native21');
 for(const row of enforcement.functions){
  if(phase==='current'&&replacements.has(row.signature)){
   // Identity's independently verified complete native profile attests this named
   // replacement. Retain coherence with the older, narrower native observation.
   const full=actual.full.functions.find(x=>x.signature===row.signature);
   required(full,'Missing explicit identity replacement');
   for(const key of Object.keys(row))required(closureCanonical(row[key as keyof FunctionRow])===closureCanonical(full[key as keyof FunctionRow]),'Incoherent identity replacement capture');
  }else if(phase==='current'&&row.signature==='gov._material_source_state(uuid)'){
   required(pins?.inheritedNativeOverride.signature===row.signature,'Missing explicit native replacement');
   required(pins.inheritedNativeOverride.fromSpecSha256===closureHash(closureCanonical(INHERITED.nativeSpecs[row.signature])),'Changed native replacement predecessor');
   // Enforcement's original query does not contain the extra full-row fields: compare against
   // the same row projection rather than confusing it with the stronger complete-row encoding.
   const full=actual.full.functions.find(x=>x.signature===row.signature);
   required(full&&closureNativeHash(full)===pins.inheritedNativeOverride.to,'Changed replacement native row');
   for(const key of Object.keys(row))required(closureCanonical(row[key as keyof FunctionRow])===closureCanonical(full[key as keyof FunctionRow]),'Incoherent replacement capture');
  }else required(inheritedNativeMatches(row,INHERITED.nativeSpecs[row.signature as keyof typeof INHERITED.nativeSpecs]),'Changed inherited native function');
 }
 required(enforcement.posture.length===1&&enforcement.posture[0].safe===true,'Changed inherited enforcement posture');
 required(enforcement.triggers.length===1&&receiptTriggerMatches(enforcement.triggers[0]),'Changed inherited receipt trigger');
 ordered(guard.objectRows,'guard objects');ordered(link.objectRows,'link objects');ordered(link.roleRows as ObjectRow[],'role/membership objects');
 const receipt=guard.objectRows.filter(x=>x.kind==='trigger'&&x.name==='episodes.material_source_receipt');
 required(receipt.length===1,'Missing/duplicate independently verified receipt trigger');
 const guardHash=closureHash(JSON.stringify(guard.objectRows.filter(x=>x!==receipt[0])));
 if(phase==='current'){
  required(pins?.inheritedGuardOverride.from===INHERITED.guardObjects&&pins.inheritedGuardOverride.to===pins.current.guardObjects,'Changed guard predecessor/override');
  required(guardHash===pins.current.guardObjects,'Changed complete guard family');
 }else required(guardHash===INHERITED.guardObjects,'Changed complete prerequisite guard family');
 required(closureHash(JSON.stringify(link.objectRows))===INHERITED.linkObjects,'Changed complete inherited link family');
 required(closureHash(JSON.stringify(link.roleRows))===INHERITED.linkRoles,'Changed complete inherited roles/memberships');
}

export function summarizeMaterialClosureProfile(actual:MaterialClosureCapture):ClosureCataloguePins {
 const {full,guard,link}=actual;
 ordered(full.objects,'complete object family');ordered(full.namespaces,'complete namespace authority');ordered(full.inventory,'complete namespace inventory');
 exactKeys(full.functions.map(x=>x.signature),FUNCTIONS,'complete function capture');
 exactKeys(full.triggers.map(x=>x.name),full.triggers.map(x=>x.name),'rich trigger family');
 const receipt=guard.objectRows.filter(x=>x.kind==='trigger'&&x.name==='episodes.material_source_receipt');
 required(receipt.length===1,'Missing historical receipt trigger');
 return {functions:Object.fromEntries(full.functions.map(row=>[row.signature,row.body===null?null:closureNativeHash(row)])),
  objects:closureHash(closureCanonical(full.objects)),triggers:closureHash(closureCanonical(full.triggers)),
  namespaces:closureHash(closureCanonical(full.namespaces)),inventory:closureHash(closureCanonical(full.inventory)),
  guardObjects:closureHash(JSON.stringify(guard.objectRows.filter(x=>x!==receipt[0]))),
  linkObjects:closureHash(JSON.stringify(link.objectRows)),linkRoles:closureHash(JSON.stringify(link.roleRows))};
}

export function validateMaterialClosurePins(pins:MaterialClosurePins|null):MaterialClosurePins {
 required(pins&&pins.version==='material-closure-foundation-v1','No compiled complete release profile');
 required(/^[a-f0-9]{40}$/.test(pins.qualifiedBaseCommit)&&sha(pins.sourceInventorySha256)&&sha(pins.payloadSha256),'Unfrozen complete release identity');
 required(pins.payloadSha256===MATERIAL_CLOSURE_RELEASE.checksum&&closureHash(MATERIAL_CLOSURE_RELEASE.sql)===pins.payloadSha256,'Unbound compiled payload profile');
 for(const [name,expected] of Object.entries({prerequisite:pins.prerequisite,current:pins.current})){
  exactKeys(Object.keys(expected.functions),FUNCTIONS,name+' compiled native scope');
  for(const signature of FUNCTIONS)required(name==='prerequisite'&&ADDED_FUNCTIONS.includes(signature)?expected.functions[signature]===null:typeof expected.functions[signature]==='string'&&sha(expected.functions[signature]!), 'Incomplete compiled native pin');
  for(const key of ['objects','triggers','namespaces','inventory','guardObjects','linkObjects','linkRoles'] as const)required(sha(expected[key]),'Incomplete compiled catalogue pin');
 }
 required(pins.inheritedNativeOverride.to===pins.current.functions['gov._material_source_state(uuid)'],'Unbound native override');
 required(pins.prerequisite.guardObjects===INHERITED.guardObjects,'Unbound prerequisite guard family');
 return pins;
}
function assertMaterialClosureScope(actual:MaterialClosureCapture,phase:'prerequisite'|'current'):void {
  const present=phase==='current'?[...BASE_FUNCTIONS,...ADDED_FUNCTIONS]:BASE_FUNCTIONS;
  exactKeys(actual.full.overloads.map(x=>x.signature),[...present,...CRYPTO_FUNCTIONS],'complete known-name overloads');
  exactKeys(actual.full.inventory.filter(x=>x.kind==='function').map(x=>x.name),present,'complete product function namespace');
  exactKeys(actual.full.objects.filter(x=>x.kind==='relation').map(x=>x.name),phase==='current'?RELATIONS:BASE_RELATIONS,'complete relation families');
  exactKeys(actual.full.namespaces.filter(x=>x.kind==='schema').map(x=>x.name),SCHEMAS,'complete owned schemas');
}
/** Retain every native scope check, including crypto known-name overloads outside product inventory. */
export const assertMaterialClosureCurrentScope=(actual:MaterialClosureCapture)=>assertMaterialClosureScope(actual,'current');
export type MaterialClosureCatalogueStatus={state:'verified'|'paused';reason:string};
async function inspect(client:pg.ClientBase,phase:'prerequisite'|'current'):Promise<MaterialClosureCatalogueStatus>{
 try{
  const pins=validateMaterialClosurePins(MATERIAL_CLOSURE_PINS); // Refuse before any target query if release data is absent/incomplete.
  const version=await client.query<{version:number}>("SELECT pg_catalog.current_setting('server_version_num')::integer AS version");
  required(version.rows.length===1&&Number.isInteger(version.rows[0].version)&&version.rows[0].version>=180000&&version.rows[0].version<190000,'PostgreSQL18 required');
  const actual=await captureMaterialClosureProfile(client);
  assertInheritedMaterialProfile(actual,phase,pins);
  const expected=pins[phase],observed=summarizeMaterialClosureProfile(actual);
  required(closureCanonical(observed)===closureCanonical(expected),'Complete material catalogue differs from its reviewed profile');
  assertMaterialClosureScope(actual,phase);
  return {state:'verified',reason:phase==='current'?'Complete material catalogue verified; history and current-use authority remain separate.':'Exact pre-closure catalogue verified; no new capability is granted.'};
 }catch(error){return {state:'paused',reason:error instanceof ProfileMismatch?error.message:'Complete material catalogue could not be inspected.'};}
}
/** No old verifier/installer or A1c call: the invocation graph is acyclic. */
export const verifyMaterialClosureCatalogue=(client:pg.ClientBase)=>inspect(client,'current');
/** Attests old workspace factory/wrappers and installation mutex metadata BEFORE replacement. */
export const verifyMaterialClosurePrerequisite=(client:pg.ClientBase)=>inspect(client,'prerequisite');
