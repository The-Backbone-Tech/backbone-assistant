import {createHash} from 'node:crypto';
import type {MaterialEntry} from '../api.ts';
import {isText,sourceText} from '../stub/material.ts';
import {workbookText} from '../stub/scripted.ts';

export type MaterialReaderProfile='harness'|'stub'|'scripted'|'historical-utf8';
type Rendering='utf8-replacement'|'source-text-fatal-utf8'|'workbook-cells'|'opaque-description'|'stub-summary-160'|'stub-opaque-description';

export interface PreparedMaterialText {
 readonly text:string;
 /** Hash of the supplied, verified retained version, not wire bytes or model receipt. */
 readonly originalSha256:string;
 readonly transformation:{readonly kind:'material-file-preparation';readonly version:'1';readonly profile:MaterialReaderProfile;readonly rendering:Rendering;readonly unicode:'utf8-roundtrip'};
}

/** Pure rendering only. The trusted caller reloads metadata under its home lock and owns all
 * liveness, generation, current/historical, held/recovery, carrier and authority checks. This
 * helper establishes none of those and never derives Core authorship from material labels. */
export function prepareMaterialText(entry:MaterialEntry,exactVersion:number,bytes:Uint8Array,profile:MaterialReaderProfile):PreparedMaterialText{
 if(!['harness','stub','scripted','historical-utf8'].includes(profile))throw new Error('Unsupported material reader profile.');
 if(!Number.isSafeInteger(exactVersion)||exactVersion<1)throw new Error('Invalid requested material version.');
 const matches=Array.isArray(entry.versions)?entry.versions.filter(version=>version?.n===exactVersion):[];
 if(matches.length!==1)throw new Error('The requested material version must have exactly one immutable record.');
 const version=matches[0];
 if(!(bytes instanceof Uint8Array)||!Number.isSafeInteger(version.bytes)||version.bytes<0||version.bytes!==bytes.byteLength)throw new Error('Material bytes do not match the immutable version byte count.');
 if(typeof version.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(version.sha256))throw new Error('Invalid immutable material version hash.');
 // One owned snapshot supplies both the verified hash and every rendering.
 const retained=Buffer.from(bytes),originalSha256=createHash('sha256').update(retained).digest('hex');
 if(originalSha256!==version.sha256.toLowerCase())throw new Error('Material bytes do not match the immutable version hash.');
 let text:string,rendering:Rendering;
 switch(profile){
  case 'historical-utf8':
   text=retained.toString('utf8');rendering='utf8-replacement';break;
  case 'scripted':
   text=isText(entry)?retained.toString('utf8'):workbookText(retained);
   rendering=isText(entry)?'utf8-replacement':'workbook-cells';break;
  case 'stub':
   if(isText(entry)){
    text=`${entry.name}: ${retained.toString('utf8').replace(/\s+/g,' ').trim().slice(0,160)}`;rendering='stub-summary-160';
   }else{
    // Describe the selected version; the old stub used the first version's size.
    text=`${entry.name}: ${entry.mediaType.split('/').pop()}, ${retained.length} bytes (the stub does not parse this format)`;rendering='stub-opaque-description';
   }
   break;
  case 'harness':{
   // sourceText's existing eligibility and fatal decoder govern parsing only, never authority.
   const explicit=isText(entry)?undefined:sourceText(entry,retained);
   if(isText(entry)){text=retained.toString('utf8');rendering='utf8-replacement';}
   else if(explicit!==undefined){text=explicit;rendering='source-text-fatal-utf8';}
   else if(entry.mediaType.includes('spreadsheetml')){text=workbookText(retained);rendering='workbook-cells';}
   else{text=`(${entry.mediaType}, ${retained.length} bytes; this format is not read as text yet)`;rendering='opaque-description';}
   break;
  }
 }
 // Labels and the stub's UTF-16 truncation can contain a lone surrogate. Make the returned
 // string exactly the UTF-8 text its consumer can encode, including replacement characters.
 // PostgreSQL text cannot store NUL. Refuse the preparation before any registration instead
 // of silently rewriting it; opaque descriptions may still represent the retained binary.
 if(text.includes('\0'))throw new Error('The prepared text contains NUL, which Core cannot record. Original bytes were not changed.');
 return {text:Buffer.from(text,'utf8').toString('utf8'),originalSha256,transformation:{kind:'material-file-preparation',version:'1',profile,rendering,unicode:'utf8-roundtrip'}};
}
