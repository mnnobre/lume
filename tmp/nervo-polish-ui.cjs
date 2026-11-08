const fs=require('node:fs');
const p='C:/Projetos/Gerenciador/tmp/nervo-scaffold/frontend/src/main.tsx';
let s=fs.readFileSync(p,'utf8');
s=s.replace('Activity,ArrowDownLeft,ArrowUpRight','Activity,ArrowUpRight');
s=s.replace('session.current=h.session_id;cursor.current=0;','cursor.current=0;');
s=s.replace('setTools(t.tools);setSystem(s.data);','setTools(t.tools);setSystem(s.data);session.current=h.session_id;');
s=s.replace('},[close]);async function run()','},[]);async function run()');
s=s.replace("'✓ Consulta concluída'","'✓ Operação concluída'");
fs.writeFileSync(p,s);
