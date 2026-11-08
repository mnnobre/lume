import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const run=join(root,'test-results',randomUUID());mkdirSync(run,{recursive:true});
assert.ok(existsSync(join(root,'target/release/nervo.exe')),'Compile primeiro: cargo build --release');
const base='http://127.0.0.1:47821';
try{await fetch(`${base}/api/health`,{signal:AbortSignal.timeout(500)});throw new Error('Porta ocupada. Encerre o Nervo antes de executar este teste isolado.');}catch(e){if(e.message.startsWith('Porta ocupada'))throw e;}
const started=performance.now();
const child=spawn(join(root,'target/release/nervo.exe'),[],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,NERVO_DATA_DIR:join(run,'data'),NERVO_WORKSPACE:join(run,'workspace')}});
let token='',headers={},startup;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];
const check=(name)=>{checks.push(name);console.log(`PASS ${name}`);};
async function health(){const r=await fetch(`${base}/api/health`,{headers,signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();}
async function tool(name,args={}){const r=await fetch(`${base}/api/tools/${name}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({arguments:args,actor:'smoke-test'}),signal:AbortSignal.timeout(8000)});assert.equal(r.status,200);return r.json();}
let id=0;
async function mcp(method,params){const r=await fetch(`${base}/mcp`,{method:'POST',headers:{...headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(8000)});assert.equal(r.status,200,await r.clone().text());const text=await r.text();return text.startsWith('data:')?JSON.parse(text.split('\n').find(l=>l.startsWith('data:')).slice(5)):JSON.parse(text);}
try{
 for(let i=0;i<100;i++){try{token=readFileSync(join(run,'data/access-token'),'utf8').trim();headers={Authorization:`Bearer ${token}`};await health();startup=performance.now()-started;break;}catch{if(child.exitCode!==null)throw new Error(`Backend exited ${child.exitCode}`);await sleep(20);}}
 assert.ok(startup);check('release starts and authenticated health responds');
 const settings=await (await fetch(`${base}/api/settings`,{headers})).json();
 async function updateSettings(snapshot){return fetch(`${base}/api/settings`,{method:'PUT',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(snapshot)});}
 const configured={revision:settings.current.revision,values:{...settings.current.values,collector_interval_ms:100,history_flush_ms:1000}};
 const saved=await updateSettings(configured);assert.equal(saved.status,200);const savedBody=await saved.json();
 assert.equal((await updateSettings(configured)).status,409);
 assert.equal((await updateSettings({...savedBody.current,values:{...configured.values,collector_interval_ms:0}})).status,400);
 assert.equal((await health()).collector_interval_ms,100);
 assert.equal(JSON.parse(readFileSync(join(run,'data/settings.json'),'utf8')).values.collector_interval_ms,100);check('settings validate, persist, apply live and prevent stale writes');
 const streamResponse=await fetch(`${base}/api/live`,{headers,signal:AbortSignal.timeout(3000)});assert.equal(streamResponse.status,200);
 const reader=streamResponse.body.getReader();let frames='';const streamStart=performance.now();
 while((frames.match(/event: telemetry/g)||[]).length<3){const {value,done}=await reader.read();assert.equal(done,false);frames+=new TextDecoder().decode(value);}
 await reader.cancel();assert.ok(performance.now()-streamStart<2500);check('SSE publishes successive live snapshots');
 const restored=await updateSettings({revision:savedBody.current.revision,values:settings.current.values});assert.equal(restored.status,200);
 assert.equal((await fetch(`${base}/api/health`)).status,401);
 assert.equal((await fetch(`${base}/api/health`,{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);check('token and browser origin enforced');
 const catalog=await (await fetch(`${base}/api/tools`,{headers})).json();assert.equal(catalog.tools.length,15);
 for(const name of ['context_get','input_get_state','windows_list','processes_list','system_get_info','clipboard_get'])assert.equal((await tool(name)).status,'ok');check('native Windows collectors respond');
 assert.equal((await tool('files_read',{path:'../escape'})).error.code,'OUTSIDE_WORKSPACE');
 assert.equal((await tool('files_write',{path:'NUL.txt',content:'bad'})).error.code,'INVALID_PATH');
 assert.equal((await tool('windows_list',{limit:-1})).error.code,'INVALID_ARGUMENT');check('path boundaries and arguments validated');
 const create=await tool('files_write',{path:'test.md',content:'# one'});assert.equal(create.status,'ok');
 const longText='a'.repeat(65535)+'áfim';writeFileSync(join(run,'workspace/large.md'),longText);
 const chunk=await tool('files_read',{path:'large.md'});assert.ok(chunk.data.next_byte_offset);
 const tail=await tool('files_read',{path:'large.md',byte_offset:chunk.data.next_byte_offset});assert.equal(chunk.data.text+tail.data.text,longText);check('paginated file reading preserves UTF-8 boundaries');
 assert.equal((await tool('files_write',{path:'test.md',content:'bad'})).error.code,'VERSION_REQUIRED');
 const race=await Promise.all(['two','three'].map(content=>tool('files_write',{path:'test.md',content,expected_version:create.data.version})));
 assert.equal(race.filter(r=>r.status==='ok').length,1);assert.equal(race.filter(r=>r.error?.code==='VERSION_CONFLICT').length,1);check('concurrent updates prevent lost writes');
 const results=await Promise.all(Array.from({length:20},()=>tool('context_get')));assert.ok(results.every(r=>r.status==='ok'||r.error?.code==='BUSY'));assert.ok(results.some(r=>r.status==='ok'));check('parallel reads complete or report bounded backpressure');
 const init=await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'nervo-smoke',version:'1.0'}});assert.ok(init.result?.serverInfo);
 const list=await mcp('tools/list',{});assert.equal(list.result?.tools.length,15);
 const called=await mcp('tools/call',{name:'context_get',arguments:{}});assert.equal(called.result?.structuredContent?.status,'ok');
 const invalid=await mcp('tools/call',{name:'files_read',arguments:{path:'../bad'}});assert.equal(invalid.result?.isError,true);check('MCP initialize, discovery, tool result and error envelopes');
 const events=(await tool('events_read',{after:0,limit:200})).data.items;assert.ok(events.every((e,i)=>i===0||e.sequence>events[i-1].sequence));check('event sequences remain ordered across writers');
 const samples=[];for(let i=0;i<8;i++){await sleep(1000);samples.push(await health());}
 while((performance.now()-started)<32500)await sleep(1000);
 const final=await health();assert.ok(final.history.persisted_events>0);assert.equal(final.history.dropped_events,0);assert.equal(final.history.last_error,null);
 const journal=(await tool('memory_list',{path:'journal'})).data.items;assert.ok(journal.length>0);const batches=(await tool('memory_list',{path:journal[0].path})).data.items;assert.ok(batches.some(i=>i.name.endsWith('.md')));check('background writer persists Markdown while API stays available');
 const report={at:new Date().toISOString(),checks,startup_poll_observed_ms:Math.round(startup),warm_idle_private_mib:samples.map(s=>s.memory.private_bytes/1024/1024),warm_idle_cpu_percent:samples.map(s=>s.cpu_percent),final_history:final.history,notes:'One local release run, OS cache state uncontrolled; CPU sampled by GetProcessTimes / logical processors. Not a benchmark guarantee.'};
 writeFileSync(join(run,'report.json'),JSON.stringify(report,null,2));writeFileSync(join(root,'test-results/latest.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
 if(token)try{await fetch(`${base}/api/shutdown`,{method:'POST',headers,signal:AbortSignal.timeout(3000)});}catch{}
 await Promise.race([new Promise(r=>child.once('exit',r)),sleep(4000)]);
 if(child.exitCode===null)child.kill();
}
