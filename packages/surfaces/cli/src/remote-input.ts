// A pasted invitation is a one-use secret. Read it without terminal echo so it
// never needs to appear in shell history or the command's argument list.
import { createInterface } from 'node:readline';
import { Writable, type Readable } from 'node:stream';

export async function readJoinDetails(link?:string,name?:string,input:Readable=process.stdin,output:Writable=process.stdout):Promise<{link:string;name:string}>{
  if(link&&name)return {link,name};
  let hidden=!link;
  const quiet=new Writable({write(chunk,_encoding,done){if(!hidden)output.write(chunk);done();}});
  const terminal=!!(input as NodeJS.ReadStream).isTTY;
  const reader=createInterface({input,output:quiet,terminal}),lines=reader[Symbol.asyncIterator]();
  const read=async(prompt:string)=>{
    output.write(prompt);
    const next=await lines.next();
    if(next.done)throw new Error('No answer was entered. Run backbone join and paste the invitation when asked.');
    return next.value;
  };
  try{
    if(!link){link=await read('Join link: ');output.write('\n');}
    hidden=false;
    if(!name)name=await read('Your name: ');
    return {link,name};
  }finally{reader.close();quiet.destroy();}
}
