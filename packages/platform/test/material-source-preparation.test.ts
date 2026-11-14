// Pure immutable-byte preparation: no data home, database, harness process or provider.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {deflateRawSync} from 'node:zlib';
import type {MaterialEntry} from '../src/api.ts';
import {prepareMaterialText,type MaterialReaderProfile} from '../src/composition/material-source-preparation.ts';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function entry(bytes:Uint8Array,patch:Partial<MaterialEntry>={}):MaterialEntry{
 return {id:'source',projectId:'project',name:'note.md',mediaType:'text/markdown',class:'original',hidden:false,current:1,
  versions:[{n:1,by:'person',at:'2026-11-09T00:00:00.000Z',bytes:bytes.byteLength,sha256:sha(bytes)}],...patch};
}
const profiles:MaterialReaderProfile[]=['harness','stub','scripted','historical-utf8'];
function wellFormed(text:string){assert.equal(Buffer.from(text,'utf8').toString('utf8'),text,'the exact prepared string roundtrips UTF-8');}
// Small owned ZIP local records, including a deflated sheet, exercise the maintained workbook reader.
function workbook(){
 return Buffer.concat([
  ['xl/sharedStrings.xml','<sst><si><t>Revenue</t></si></sst>',false],
  ['xl/worksheets/sheet1.xml','<worksheet><c><v>12</v></c><c><t>Zebra</t></c></worksheet>',true],
 ].map(([name,xml,compressed])=>{
  const path=Buffer.from(String(name)),body=Buffer.from(String(xml)),data=compressed?deflateRawSync(body):body,header=Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(compressed?8:0,8);header.writeUInt32LE(data.length,18);header.writeUInt16LE(path.length,26);
  return Buffer.concat([header,path,data]);
 }));
}

test('profiles preserve their distinct existing text renderings and explicit transformation metadata',()=>{
 const bytes=Buffer.from('  First\n\tsecond 😀  '),source=entry(bytes),before=structuredClone(source);
 for(const profile of profiles){
  const prepared=prepareMaterialText(source,1,bytes,profile);
  assert.equal(prepared.text,profile==='stub'?'note.md: First second 😀':bytes.toString('utf8'));
  assert.equal(prepared.originalSha256,sha(bytes));
  assert.deepEqual(prepared.transformation,{kind:'material-file-preparation',version:'1',profile,rendering:profile==='stub'?'stub-summary-160':'utf8-replacement',unicode:'utf8-roundtrip'},'native registration requires nonempty string kind/version');
  wellFormed(prepared.text);
 }
 assert.deepEqual(source,before,'preparation mutates no metadata');
});

test('only the requested immutable historical version supplies the hash and text',()=>{
 const old=Buffer.from('Old text'),current=Buffer.from('New text'),source=entry(old,{class:'working',current:2});
 source.versions.push({n:2,by:'agent',at:'2026-11-09T01:00:00.000Z',bytes:current.length,sha256:sha(current)});
 assert.equal(prepareMaterialText(source,1,old,'historical-utf8').text,'Old text');
 assert.equal(prepareMaterialText(source,2,current,'historical-utf8').text,'New text');
 assert.throws(()=>prepareMaterialText(source,1,current,'historical-utf8'),/hash|bytes/i,'a current version cannot substitute for the selected history');
 source.versions[1].sha256='broken unrelated metadata';
 assert.equal(prepareMaterialText(source,1,old,'historical-utf8').originalSha256,sha(old),'this helper validates the selected record, not unrelated history');
});

for(const profile of profiles)test(`${profile} refuses byte tampering, absent/duplicate versions and malformed immutable metadata`,()=>{
 const bytes=Buffer.from('same'),source=entry(bytes,{name:'opaque.bin',mediaType:'application/octet-stream'});
 assert.throws(()=>prepareMaterialText(source,1,Buffer.from('tame'),profile),/hash/i);
 assert.throws(()=>prepareMaterialText(source,1,Buffer.from('shorter'),profile),/bytes/i);
 assert.throws(()=>prepareMaterialText({...source,versions:[]},1,bytes,profile),/version/i);
 assert.throws(()=>prepareMaterialText({...source,versions:[source.versions[0],{...source.versions[0],sha256:'f'.repeat(64)}]},1,bytes,profile),/version/i);
 for(const malformed of ['x'.repeat(64),'a'.repeat(63),'sha256:'+sha(bytes),''])assert.throws(()=>prepareMaterialText({...source,versions:[{...source.versions[0],sha256:malformed}]},1,bytes,profile),/hash/i);
 for(const size of [-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>prepareMaterialText({...source,versions:[{...source.versions[0],bytes:size}]},1,bytes,profile),/bytes/i);
 for(const version of [0,-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>prepareMaterialText(source,version,bytes,profile),/version/i);
 assert.equal(prepareMaterialText({...source,versions:[{...source.versions[0],sha256:sha(bytes).toUpperCase()}]},1,bytes,profile).originalSha256,sha(bytes),'valid hex metadata compares to the computed canonical hash');
});

test('binary descriptions report the selected version byte count, and scripted binary keeps the existing workbook fallback',()=>{
 const first=Buffer.from([1,2]),selected=Buffer.from([0,255,2,3,4,5,6,7]);
 const source=entry(first,{name:'image.bin',mediaType:'application/custom-binary',current:2});
 source.versions.push({...source.versions[0],n:2,bytes:selected.length,sha256:sha(selected)});
 const native=prepareMaterialText(source,2,selected,'harness'),stub=prepareMaterialText(source,2,selected,'stub');
 assert.equal(native.text,'(application/custom-binary, 8 bytes; this format is not read as text yet)');
 assert.equal(native.transformation.rendering,'opaque-description');
 assert.equal(stub.text,'image.bin: custom-binary, 8 bytes (the stub does not parse this format)');
 assert.equal(stub.transformation.rendering,'stub-opaque-description');
 const scripted=prepareMaterialText(source,2,selected,'scripted');assert.equal(scripted.text,'');assert.equal(scripted.transformation.rendering,'workbook-cells');
 assert.throws(()=>prepareMaterialText(source,2,selected,'historical-utf8'),/NUL/i,'opaque binary bytes remain retained but cannot silently become PostgreSQL text');
});

test('prepared NUL refuses before Core while original bytes remain unchanged and opaque binary stays describable',()=>{
 const bytes=Buffer.from('first\0second'),source=entry(bytes),original=Buffer.from(bytes);
 for(const profile of profiles)assert.throws(()=>prepareMaterialText(source,1,bytes,profile),/NUL/i);
 assert.deepEqual(bytes,original,'refusal does not erase or rewrite the retained original');
 const binary=entry(bytes,{name:'source.bin',mediaType:'application/octet-stream'});
 assert.equal(prepareMaterialText(binary,1,bytes,'harness').transformation.rendering,'opaque-description');
});

test('harness and scripted workbook profiles reuse sheet cells while stub keeps an opaque summary',()=>{
 const bytes=workbook(),source=entry(bytes,{name:'cells.xlsx',mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 for(const profile of ['harness','scripted'] as const){const prepared=prepareMaterialText(source,1,bytes,profile);assert.equal(prepared.text,'Revenue 12 Zebra');assert.equal(prepared.transformation.rendering,'workbook-cells');assert.equal(prepared.originalSha256,sha(bytes));}
 assert.match(prepareMaterialText(source,1,bytes,'stub').text,/^cells\.xlsx: .* bytes \(the stub does not parse this format\)$/);
});

test('explicit sourceText fallback preserves fatal UTF-8, BOM, NUL and exact octet-size boundaries',()=>{
 const prepare=(bytes:Uint8Array,patch:Partial<MaterialEntry>={})=>prepareMaterialText(entry(bytes,{name:'code/source.py',mediaType:'application/octet-stream',projection:'managed',source:{kind:'person',path:'code/source.py'},...patch}),1,bytes,'harness');
 const valid=prepare(Buffer.from([0xef,0xbb,0xbf,65]));assert.equal(valid.text,'\ufeffA');assert.equal(valid.transformation.rendering,'source-text-fatal-utf8');
 assert.equal(prepare(Buffer.from('print("😀")')).text,'print("😀")');
 for(const bytes of [Buffer.from([0xc3,0x28]),Buffer.from([65,0,66]),Buffer.alloc(2_000_001,65)]){
  const result=prepare(bytes);assert.equal(result.transformation.rendering,'opaque-description');assert.equal(result.text,`(application/octet-stream, ${bytes.length} bytes; this format is not read as text yet)`);wellFormed(result.text);
 }
 assert.equal(prepare(Buffer.alloc(2_000_000,65)).text.length,2_000_000);
 assert.equal(prepare(Buffer.from('print(1)'),{fromServer:{connection:'server',tool:'look'}}).transformation.rendering,'opaque-description','legacy server material cannot invent explicit person-source fallback');
 assert.equal(prepare(Buffer.from('print(1)'),{mediaType:'application/x-python-code'}).transformation.rendering,'opaque-description');
});

test('stub truncation and all name/byte decoding paths return well-formed Unicode',()=>{
 const bytes=Buffer.from('a'.repeat(159)+'😀 trailing');
 const stub=prepareMaterialText(entry(bytes),1,bytes,'stub');assert.equal(stub.text,'note.md: '+'a'.repeat(159)+'\ufffd');wellFormed(stub.text);
 const malformed=Buffer.from([65,0xff,66]);
 for(const profile of profiles){const prepared=prepareMaterialText(entry(malformed,{name:'label\ud800.md'}),1,malformed,profile);wellFormed(prepared.text);assert.equal(prepared.originalSha256,sha(malformed));}
 assert.equal(prepareMaterialText(entry(malformed),1,malformed,'harness').text,'A\ufffdB','existing MIME text uses replacement decoding, unlike explicit sourceText');
});

test('unsupported profiles refuse instead of silently choosing another rendering',()=>{
 const bytes=Buffer.from('text');assert.throws(()=>prepareMaterialText(entry(bytes),1,bytes,'arbitrary-text' as MaterialReaderProfile),/profile/i);
});
