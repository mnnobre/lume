const fs=require('node:fs');
const p='C:/Projetos/Gerenciador/tmp/nervo-scaffold/frontend/src/main.tsx';
let s=fs.readFileSync(p,'utf8');
s=s.replace('async function open(i:Obj){',`async function more(){if(!file)return;try{const r=await call('memory_read',{path:file.path,byte_offset:file.next_byte_offset});if(r.status!=='ok')throw new Error(r.error.message);setFile({...r.data,text:file.text+r.data.text});}catch(e){setError(String(e));}}async function open(i:Obj){`);
s=s.replace('Visualização limitada aos primeiros 64 KiB.','Há mais conteúdo disponível neste arquivo.').replace('<pre>{file.text}</pre></div>','<pre>{file.text}</pre>{file.next_byte_offset!==null&&<button className="text-button" onClick={more}>Ler próximo bloco</button>}</div>');
fs.writeFileSync(p,s);
