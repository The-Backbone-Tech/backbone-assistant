// Disposable issuer: real signatures and PKCE, scripted subjects, no tenant or account.
import {createServer} from 'node:http';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import assert from 'node:assert/strict';
export async function identityProviderFixture(){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});let issuer='';
 const codes=new Map<string,{subject:string;nonce:string;challenge:string;client:string}>();
 const server=createServer(async(request,response)=>{
  response.setHeader('content-type','application/json');
  if(request.url==='/.well-known/openid-configuration')return response.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256']}));
  if(request.url==='/jwks')return response.end(JSON.stringify({keys:[{...publicKey.export({format:'jwk'}),kid:'fixture',use:'sig',alg:'RS256'}]}));
  if(request.url!=='/token'){response.statusCode=404;return response.end('{}');}
  const chunks=[];for await(const chunk of request)chunks.push(chunk);
  const body=new URLSearchParams(Buffer.concat(chunks).toString()),proof=codes.get(body.get('code')??'');codes.delete(body.get('code')??'');
  if(!proof||createHash('sha256').update(body.get('code_verifier')??'').digest('base64url')!==proof.challenge){response.statusCode=400;return response.end(JSON.stringify({error:'invalid_grant'}));}
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt=encode({alg:'RS256',kid:'fixture'})+'.'+encode({iss:issuer,aud:proof.client,sub:proof.subject,name:'Directory colleague',nonce:proof.nonce,exp:Math.floor(Date.now()/1000)+300,iat:Math.floor(Date.now()/1000)});
  response.end(JSON.stringify({access_token:'disposable-fixture',token_type:'Bearer',id_token:jwt+'.'+sign('RSA-SHA256',Buffer.from(jwt),privateKey).toString('base64url')}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));issuer=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 return {issuer,callback(authorization:URL,subject:string){assert.equal(authorization.origin,issuer);const code=randomUUID();codes.set(code,{subject,nonce:authorization.searchParams.get('nonce')!,challenge:authorization.searchParams.get('code_challenge')!,client:authorization.searchParams.get('client_id')!});const callback=new URL(authorization.searchParams.get('redirect_uri')!);callback.searchParams.set('state',authorization.searchParams.get('state')!);callback.searchParams.set('code',code);return callback;},async close(){await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}};
}
