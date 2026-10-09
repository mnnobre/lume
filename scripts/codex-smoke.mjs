import {spawn} from 'node:child_process';
import {existsSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createInterface} from 'node:readline';

const base=join(homedir(),'AppData','Local','OpenAI','Codex','bin');
const exe=readdirSync(base).map(d=>join(base,d,'codex.exe')).filter(existsSync).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];
const child=spawn(exe,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
const lines=createInterface({input:child.stdout});
let seq=0;const pending=new Map();let stderr='';
child.stderr.on('data',d=>stderr+=d.toString());
lines.on('line',line=>{try{const o=JSON.parse(line);if(o.id!=null&&pending.has(o.id)){pending.get(o.id)(o);pending.delete(o.id);}}catch{}});
function call(method,params={}){
  const id=++seq;child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  return Promise.race([new Promise(resolve=>pending.set(id,resolve)),new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${method}: timeout; exit=${child.exitCode}; stderr=${stderr}`)),10000))]).then(o=>{if(o.error)throw new Error(o.error.message);return o.result;});
}
try{
  await call('initialize',{clientInfo:{name:'lume_smoke',title:'Lume read-only validation',version:'0.1.1'},capabilities:null});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
  const threads=await call('thread/list',{limit:100,sourceKinds:['cli','vscode','appServer'],sortKey:'updated_at'});
  console.log(`thread/list: OK, rows=${threads.data.length}`);
  const archived=await call('thread/list',{limit:10,archived:true,sourceKinds:['cli','vscode','appServer']});
  console.log(`archived list: OK, rows=${archived.data.length}`);
  const models=await call('model/list',{});console.log(`model/list: OK, models=${models.data.length}`);
  if(threads.data.length){
    const read=await call('thread/read',{threadId:threads.data[0].id,includeTurns:true});console.log(`thread/read: OK, turns=${read.thread.turns.length}`);
    const skills=await call('skills/list',{cwds:[threads.data[0].cwd]});console.log(`skills/list: OK, scopes=${skills.data.length}`);
  }
}finally{child.kill();}
