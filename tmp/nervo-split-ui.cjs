const fs=require('node:fs');
const root='C:/Projetos/Nervo/frontend';
const stage='C:/Projetos/Gerenciador/tmp/nervo-scaffold/frontend';
for(const file of ['src/style.css','vite.config.ts','tsconfig.json','package.json','index.html'])fs.copyFileSync(root+'/'+file,stage+'/'+file);
let app=fs.readFileSync(root+'/src/main.tsx','utf8');
const end=app.lastIndexOf('createRoot(');if(end<0)throw new Error('Missing React root');
app=app.slice(0,end).replace(/^import .*createRoot.*;\r?\n/m,'').replace(/^import ['"]\.\/style\.css['"];\r?\n/m,'').replace(/function App\(\)\s*\{/,'export default function App() {');
fs.writeFileSync(stage+'/src/App.tsx',app);
fs.writeFileSync(stage+'/src/main.tsx','import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./style.css";\n\ncreateRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);\n');
