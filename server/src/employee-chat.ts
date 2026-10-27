import {request} from "node:http";
import {dirname,join} from "node:path";
import {lstat,realpath} from "node:fs/promises";
import {createHash} from "node:crypto";
export async function presentEmployeeCard(data:string,input:{draftId:string;version:number;revision:number}) {
 const directory=join(dirname(data),"iva-panels");
 if(await realpath(directory)!==directory)throw new Error("CHAT_SOCKET_INVALID");
 const path=join(directory,"chat.sock"),st=await lstat(path);
 if(!st.isSocket()||(st.mode&0o077)||st.uid!==process.getuid?.())throw new Error("CHAT_SOCKET_INVALID");
 const body=JSON.stringify({schema:"iva-panels/chat-v1",plugin:"bitrix24-read",action:`emp-${input.draftId}`,revision:input.revision,requestId:createHash("sha256").update(`${input.draftId}:${input.version}`).digest("hex").slice(0,24)});
 return new Promise<{state:string}>((resolve,reject)=>{
 const req=request({socketPath:path,path:"/cards/v1",method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)},signal:AbortSignal.timeout(10000)},res=>{
 const chunks:Buffer[]=[];let size=0;res.on("data",c=>{size+=c.length;if(size>4096)res.destroy(new Error("TOO_LARGE"));else chunks.push(Buffer.from(c));});res.on("error",reject);res.on("end",()=>{try{const v=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200||v.schema!=="iva-panels/chat-v1"||!["presented","already_presented","delivery_unknown"].includes(v.state))throw new Error("CHAT_CARD_UNAVAILABLE");resolve({state:v.state});}catch(e){reject(e);}});
 });req.on("error",reject);req.end(body);
 });
}
