// Conservative offline definition index, not a SQL parser or an execution security boundary.
// New syntax is refused for review rather than guessed. Native catalogue/profile controls remain.
const aliases=new Map([
 ['text','text'],['uuid','uuid'],['jsonb','jsonb'],['boolean','boolean'],['bool','boolean'],
 ['integer','integer'],['int','integer'],['int4','integer'],['bigint','bigint'],['int8','bigint'],
 ['smallint','smallint'],['int2','smallint'],['timestamptz','timestamp with time zone'],
 ['timestamp with time zone','timestamp with time zone'],['date','date'],
 // Closed existing composite used by the draft claim encoder. Its actual columns/ownership
 // remain part of the native complete profile, never inferred from this lexical type name.
 ['app.knowledge_candidates','app.knowledge_candidates'],
]);
function fail(message) {throw new Error(message);}
export function sqlTokens(sql) {
 const out=[]; let i=0;
 while (i<sql.length) {
  const rest=sql.slice(i);
  const whitespace=/^\s+/.exec(rest); if(whitespace){i+=whitespace[0].length;continue;}
  if(rest.startsWith('--')) {const j=sql.indexOf('\n',i+2);i=j<0?sql.length:j+1;continue;}
  if(rest.startsWith('/*')) {
   i+=2;let depth=1;
   while(i<sql.length&&depth){if(sql.startsWith('/*',i)){depth++;i+=2;}else if(sql.startsWith('*/',i)){depth--;i+=2;}else i++;}
   if(depth)fail('unterminated SQL comment');continue;
  }
  const dollar=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
  if(dollar){const end=sql.indexOf(dollar[0],i+dollar[0].length);if(end<0)fail('unterminated SQL body');out.push('<literal>');i=end+dollar[0].length;continue;}
  if(rest[0]==="'") {
   const escaped=i>0&&/[eE]/.test(sql[i-1])&&(i<2||!/[A-Za-z0-9_$]/.test(sql[i-2]));
   i++;let closed=false;
   while(i<sql.length){if(escaped&&sql[i]==='\\'){i+=2;continue;}if(sql[i]==="'"){if(sql[i+1]==="'"){i+=2;continue;}i++;closed=true;break;}i++;}
   if(!closed)fail('unterminated SQL literal');out.push('<literal>');continue;
  }
  if(rest[0]==='"') {
   i++;let closed=false;
   while(i<sql.length){if(sql[i]==='"'){if(sql[i+1]==='"'){i+=2;continue;}i++;closed=true;break;}i++;}
   if(!closed)fail('unterminated SQL identifier');out.push('<quoted-identifier>');continue;
  }
  const word=/^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest);
  if(word){out.push(word[0].toLowerCase());i+=word[0].length;continue;}
  out.push(sql[i++]);
 }
 return out;
}
function parameterType(tokens) {
 let depth=0,cut=tokens.length;
 for(let i=0;i<tokens.length;i++){
  if(tokens[i]==='('||tokens[i]==='[')depth++;
  if(tokens[i]===')'||tokens[i]===']')depth--;
  if(depth===0&&(tokens[i]==='default'||tokens[i]==='=')){cut=i;break;}
 }
 let type=tokens.slice(0,cut);
 const output=type[0]==='out';
 if(output)type=type.slice(1);
 if(type[0]==='in')type=type.slice(1);
 if(['inout','variadic'].includes(type[0]))fail('unsupported SQL argument mode');
 // Existing canonical sources have named arguments; unnamed arguments are accepted only when
 // their entire type is recognized. Do not remove an arbitrary token to guess a custom type.
 const recognize=parts=>{
  let array=false;
  if(parts.at(-2)==='['&&parts.at(-1)===']'){array=true;parts=parts.slice(0,-2);}
  const base=aliases.get(parts.join(' ').replaceAll(' . ','.'));return base ? base+(array?'[]':'') : null;
 };
 let value=recognize(type);
 if(!value&&/^[a-z_][a-z0-9_$]*$/.test(type[0]??''))value=recognize(type.slice(1));
 if(!value)fail('unsupported SQL argument type');
 return output?null:value;
}
export function functionDeclarations(sql) {
 const tokens=sqlTokens(sql),declarations=[];
 for(let i=0;i<tokens.length;i++){
  if(tokens[i]!=='create')continue;
  let cursor=i+1;
  if(tokens[cursor]==='or'&&tokens[cursor+1]==='replace')cursor+=2;
  if(tokens[cursor++]!=='function')continue;
  const schema=tokens[cursor++],dot=tokens[cursor++],name=tokens[cursor++];
  if(!/^[a-z_][a-z0-9_$]*$/.test(schema??'')||dot!=='.'||!/^[a-z_][a-z0-9_$]*$/.test(name??'')||tokens[cursor++]!=='(')
   fail('unsupported SQL function name');
  let depth=0,parameter=[],parameters=[],closed=false;
  for(;cursor<tokens.length;cursor++){
   const token=tokens[cursor];
   if(token===')'&&depth===0){if(parameter.length)parameters.push(parameter);closed=true;break;}
   if(token===','&&depth===0){if(!parameter.length)fail('empty SQL argument');parameters.push(parameter);parameter=[];continue;}
   if(token==='('||token==='[')depth++;
   if(token===')'||token===']')depth--;
   if(depth<0)fail('unbalanced SQL argument');
   parameter.push(token);
  }
  if(!closed || !(tokens[cursor+1]==='returns' ||
      parameters.some(p=>p[0]==='out') && tokens[cursor+1]==='language'))fail('unsupported SQL function declaration');
  declarations.push(`${schema}.${name}(${parameters.map(parameterType).filter(type=>type!==null).join(',')})`);
  i=cursor;
 }
 return declarations;
}

/** Only the function portion of the manifest is checked here. Relation/trigger/policy syntax
 * and actual dependency/role semantics require the owning check and native verifier. */
export function functionVersionIndex(bootstrap,versions) {
 const index=new Map();
 function version(files,version,changes) {
  const seen=new Set();
  for(const [file,bytes] of files){
   for(const signature of functionDeclarations(new TextDecoder('utf-8',{fatal:true}).decode(bytes))){
    if(seen.has(signature))fail('duplicate function in version');seen.add(signature);
    if(changes){
     const declarations=changes.filter(row=>row.object===`function ${signature}`);
     if(declarations.length!==1||declarations[0].file!==file)fail('function declaration mismatch');
     const action=declarations[0].action;
     if(action==='add'&&index.has(signature))fail('add existing function');
     if(action==='replace'&&!index.has(signature))fail('replace absent function');
     if(!['add','replace'].includes(action))fail('function declaration action');
    }
    index.set(signature,{version,file});
   }
  }
  if(changes&&changes.some(row=>row.object.startsWith('function ')&&!seen.has(row.object.slice('function '.length))))fail('declared function absent');
 }
 version(bootstrap,'baseline',null);
 for(const {manifest,sources} of versions)version(sources,manifest.version,manifest.changes);
 return [...index].sort(([a],[b])=>a<b?-1:a>b?1:0);
}
