import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serverFromEnvironment } from "../plugin/server.mjs";

// No Panels process, descriptor, socket, service or sibling plugin directory.
const root = await realpath(await mkdtemp("/tmp/employee-standalone-"));
const data=join(root,"bitrix24-read");
const { mkdir }=await import("node:fs/promises");
await mkdir(data,{mode:0o700});
const env={PLUGIN_ROOT:join(root,"custom","plugins","bitrix24-read"),PLUGIN_DATA:data,BITRIX24_WEBHOOK_BASE_URL:"https://portal.example.test/rest/123/synthetic",BITRIX24_SETTINGS_DEFAULTS:"restricted"};
const people=[];
let writes=0;
const fetcher=async(url,init)=>{
 const method=new URL(String(url)).pathname.split("/").at(-1).replace(/\.json$/u,"");
 const params=JSON.parse(String(init.body));
 if(method==="scope")return Response.json({result:["user","department"]});
 if(method==="department.get")return Response.json({result:[{ID:"1",NAME:"Synthetic design",PARENT:"0"}]});
 if(method==="user.get")return Response.json({result:people.filter(p=>(!params.FILTER?.ID||Number(p.ID)===params.FILTER.ID)&&(!params.FILTER?.EMAIL||p.EMAIL===params.FILTER.EMAIL))});
 if(method==="user.add"){writes++;people.push({ID:20,...params,ACTIVE:true});return Response.json({result:20});}
 if(method==="user.update"){writes++;Object.assign(people[0],params);return Response.json({result:true});}
 throw new Error("UNEXPECTED_SYNTHETIC_METHOD");
};
let server,client;
async function connect(){
 server=await serverFromEnvironment(env,{fetch:fetcher});
 client=new Client({name:"standalone-employee-bundle",version:"1"});
 const [left,right]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(right),client.connect(left)]);
}
async function call(name,args){
 const response=await client.callTool({name,arguments:args});
 assert.equal(response.isError,undefined,JSON.stringify(response));
 return JSON.parse(response.content[0].text);
}
const draft=args=>call("bitrix24_employee_draft",args);
const reply=value=>call("bitrix24_employee_reply",{reply:value});
async function card(action,fields){
 let d=await draft({op:"collect",action,fields});
 d=await draft({op:"preview",draftId:d.draftId,version:d.version});
 return draft({op:"present",draftId:d.draftId,version:d.version});
}
try{
 await writeFile(join(data,"settings.json"),JSON.stringify({schema:1,revision:0,policy:{mode:"confirmed_write",uploads:false,deletions:false,people:"work",email:true,employees:true}}),{mode:0o600});
 await connect();
 const tools=(await client.listTools()).tools;
 const schema=tools.find(t=>t.name==="bitrix24_employee_draft").inputSchema;
 assert.equal(schema.type,"object");
 assert.deepEqual(schema.properties.op.enum,["collect","preview","present","cancel","status"]);
 assert.ok(tools.find(t=>t.name==="bitrix24_employee_reply").inputSchema.properties.reply.pattern);
 for(const name of ["bitrix24_settings","iva_bitrix24_update_check","bitrix24_prepare_task_action"])assert.ok(tools.some(t=>t.name===name),name);
 const fields={name:"Synthetic",lastName:"Example",email:"synthetic@example.test",departmentIds:[1],position:"Designer"};
 let d=await card("invite",fields);
 assert.match(d.presentation.markdown,/<tg-button-row>/u);
 assert.equal((await reply(d.presentation.cancelReply)).state,"cancelled");
 assert.equal((await reply(d.presentation.confirmReply)).code,"EMPLOYEE_OFFER_USED");
 assert.equal(writes,0);
 d=await card("invite",fields);
 const accepted=await reply(d.presentation.confirmReply);
 assert.equal(accepted.state,"queued");
 assert.equal(accepted.result.state,"applied");
 assert.equal(writes,1);
 await client.close();await server.close();await connect();
 assert.equal((await reply(d.presentation.confirmReply)).code,"EMPLOYEE_OFFER_USED");
 assert.equal(writes,1);
 const edited=await card("update",{userId:20,position:"Lead designer"});
 assert.equal((await reply(edited.presentation.confirmReply)).result.state,"applied");
 assert.equal(people[0].WORK_POSITION,"Lead designer");
 const dismissed=await card("dismiss",{userId:20});
 assert.match(dismissed.summary,/Активен → Уволен/u);
 assert.equal((await reply(dismissed.presentation.confirmReply)).result.state,"applied");
 assert.equal(people[0].ACTIVE,"N");
 assert.equal(writes,3);
 // Settings have their own rich approval, independent of the optional legacy API.
 const settings=await call("bitrix24_settings",{screen:"actions"});
 const proposal=await call("bitrix24_settings",{reply:`b24s:set:${settings.settings.revision}:employees_off`});
 assert.equal((await call("bitrix24_settings",{reply:proposal.cancelReply})).settings.policy.employees,true);
 const confirmed=await call("bitrix24_settings",{reply:`b24s:set:${settings.settings.revision}:employees_off`});
 assert.equal((await call("bitrix24_settings",{reply:confirmed.confirmReply})).settings.policy.employees,false);
 await assert.rejects(access(join(root,"iva-panels")));
 console.log("standalone employee bundle ok: actual MCP discovery, rich cancel/invite/update/dismiss, readback, restart/replay, settings; no Panels; synthetic portal only");
}finally{
 await client?.close();await server?.close();await rm(root,{recursive:true,force:true});
}
