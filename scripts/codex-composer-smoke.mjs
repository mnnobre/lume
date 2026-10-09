// Read-only protocol check; never starts a turn or compacts a user's thread.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';

const exe=process.argv[2];
if(!exe) throw new Error('Pass the installed codex executable path');
const child=spawn(exe,['app-server'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
const lines=createInterface({input:child.stdout});
const pending=new Map();let seq=0;
child.stderr.resume();
lines.on('line',line=>{
  let packet;try{packet=JSON.parse(line);}catch{return;}
  const request=pending.get(packet.id);
  if(!request)return;
  pending.delete(packet.id);clearTimeout(request.timer);
  packet.error?request.reject(new Error(packet.error.message)):request.resolve(packet.result);
});
child.on('error',error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();});
function call(method,params={}){
  return new Promise((resolve,reject)=>{
    const id=++seq;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method}: timeout`));},30000);
    pending.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
try {
  await call('initialize',{clientInfo:{name:'lume_composer_check',version:'0.1.1'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
  const requests=[
    ['app/list',{limit:5}],
    ['plugin/list',{cwds:[process.cwd()]}],
    ['mcpServerStatus/list',{limit:5}],
    ['collaborationMode/list',{}],
    ['thread/list',{limit:1,sourceKinds:['cli','vscode','appServer']}],
  ];
  const results=await Promise.allSettled(requests.map(async([method,params])=>{
    const result=await call(method,params);
    if(method==='plugin/list')assert.ok(Array.isArray(result.marketplaces));
    else assert.ok(Array.isArray(result.data));
    console.log(`PASS ${method}: ${method==='plugin/list'?result.marketplaces.length:result.data.length} entries`);
    return result;
  }));
  for(let i=0;i<results.length;i++)if(results[i].status==='rejected'){
    console.error(`FAIL ${requests[i][0]}: ${results[i].reason.message}`);process.exitCode=1;
  }
  const threads=results.at(-1);
  if(threads.status==='fulfilled'&&threads.value.data.length){
    const result=await call('thread/read',{threadId:threads.value.data[0].id,includeTurns:false});
    assert.ok(result.thread);
    console.log(`PASS thread/read: model=${typeof result.thread.model}, reasoningEffort=${typeof result.thread.reasoningEffort}`);
  }
} finally {
  for(const p of pending.values())clearTimeout(p.timer);
  lines.close();child.kill();
}
