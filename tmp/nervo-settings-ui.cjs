const fs=require('node:fs');const p='C:/Projetos/Gerenciador/tmp/nervo-scaffold/frontend/src/App.tsx';let s=fs.readFileSync(p,'utf8');
s='import Settings, {loadPreferences} from "./Settings";\n'+s.replace('  Search,','  Search,\n  SlidersHorizontal,');
s=s.replace('export default function App() {','export default function App() {\n  const [preferences,setPreferences]=useState(loadPreferences);\n  const [transport,setTransport]=useState("connecting");');
const begin=s.indexOf('  useEffect(() => {',s.indexOf('export default function App'));
const end=s.indexOf('  const connected',begin);
s=s.slice(0,begin)+`  useEffect(() => {
    let disposed=false, generation=0, timer:ReturnType<typeof setTimeout>, source:EventSource|undefined;
    function consume(h:Obj,c:Obj,e:Obj){
      const changed=session.current!==h.session_id;
      if(changed){session.current=h.session_id;cursor.current=0;setGap(false);setSamples([]);}
      cursor.current=e.next_cursor;setGap(v=>(changed?false:v)||e.gap);
      setEvents(v=>[...(changed?[]:v),...e.items].slice(-100));setHealth(h);setContext(c);
      if(h.cpu_percent!==null)setSamples(v=>[...v,h.cpu_percent].slice(-preferences.chart_samples));
      setError('');setUpdated(new Date().toISOString());setTransport('connected');
    }
    async function poll(run:number){
      try{const [h,c]=await Promise.all([request('health'),call('context_get')]);
        if(disposed||run!==generation)return;
        const e=await call('events_read',{after:session.current===h.session_id?cursor.current:0,limit:200});
        if(disposed||run!==generation)return;
        if(c.status!=='ok'||e.status!=='ok')throw new Error('O núcleo está ocupado; aguardando próxima consulta.');
        consume(h,c.data,e.data);
      }catch(e){if(!disposed&&run===generation){setError(e instanceof Error?e.message:String(e));setTransport('connecting');}}
      finally{if(!disposed&&run===generation)timer=setTimeout(()=>poll(run),preferences.interval_ms);}
    }
    function start(){
      generation++;clearTimeout(timer);source?.close();
      if(preferences.pause_hidden&&document.hidden){setTransport('paused');return;}
      const run=generation;setTransport('connecting');
      if(preferences.mode==='events'){
        // A new stream begins at the start of the bounded recent-event buffer.
        session.current='';cursor.current=0;
        source=new EventSource('/api/live');
        source.addEventListener('telemetry',(event)=>{if(disposed||run!==generation)return;try{const f=JSON.parse((event as MessageEvent).data);consume(f.health,f.context,f.events);}catch{setError('Resposta de telemetria inválida.');}});
        source.onerror=()=>{if(!disposed&&run===generation){session.current='';cursor.current=0;setTransport('connecting');setError('Conexão ao vivo interrompida. Reconectando automaticamente…');}};
      }else{poll(run);}
    }
    start();document.addEventListener('visibilitychange',start);
    return()=>{disposed=true;generation++;clearTimeout(timer);source?.close();document.removeEventListener('visibilitychange',start);};
  },[preferences]);
  useEffect(()=>{let cancelled=false;if(health?.session_id)Promise.all([request('tools'),call('system_get_info')]).then(([t,s])=>{if(!cancelled){setTools(t.tools);setSystem(s.data);}}).catch(()=>{});return()=>{cancelled=true;};},[health?.session_id]);
`+s.slice(end);
s=s.replace('{ name: "Conexão", icon: Plug },','{ name: "Conexão", icon: Plug },\n    { name: "Configurações", icon: SlidersHorizontal },');
s=s.replace(': "INTERFACE PARA ASSISTENTES"',': tab === "Configurações" ? "PREFERÊNCIAS E DESEMPENHO" : "INTERFACE PARA ASSISTENTES"');
s=s.replace(': "Pronto para se conectar."',': tab === "Configurações" ? "No seu ritmo." : "Pronto para se conectar."');
s=s.replace(': "Um backend independente para todos os seus assistentes."',': tab === "Configurações" ? "Ajuste atualização, coleta e memória sem reiniciar o núcleo." : "Um backend independente para todos os seus assistentes."');
s=s.replace('<div className="live">','<button className="live" title="Configurar atualização" onClick={()=>setTab("Configurações")}>');
s=s.replace('{connected ? "Ao vivo · 2 s" : "Sem conexão"}\n            </div>','{transport==="paused"?"Painel pausado":connected?(preferences.mode==="events"?"Ao vivo · eventos":`Ao vivo · ${preferences.interval_ms} ms`):"Sem conexão"}\n            </button>');
s=s.replace('detail={`Lotes a cada 30 s ou 256 KiB`}','detail={`Lotes: ${health?.history?.flush_interval_ms ?? "—"} ms ou ${(health?.history?.batch_threshold_bytes ?? 0)/1024} KiB`}');
s=s.replace('          {tab === "Visão geral" && (','          {tab === "Configurações" && <Settings preferences={preferences} onChange={setPreferences}/> }\n          {tab === "Visão geral" && (');
fs.writeFileSync(p,s);
const css='C:/Projetos/Gerenciador/tmp/nervo-scaffold/frontend/src/style.css';fs.appendFileSync(css,`
.settings-grid{display:grid;grid-template-columns:1fr 1.15fr;gap:22px;align-items:start}.settings-body{padding:24px}.settings-body>label:not(.check-row){display:flex;justify-content:space-between;gap:10px;font-size:12px;color:#c1ceb8;margin:19px 0 10px}.settings-body>label:first-child{margin-top:0}.settings-body label>span:not(:only-child){color:#8d9e80}.settings-body input[type=number],.settings-body select{width:100%;border:1px solid #405036;background:#11180e;border-radius:6px;padding:12px;color:#e2ecd9;font:12px 'IBM Plex Mono',monospace;min-width:0}.settings-body input:disabled{opacity:.4}.settings-body select{font-family:inherit;color-scheme:dark}.setting-help{font-size:11px;color:#8b9b82;line-height:1.8;margin:10px 0 18px}.check-row{display:flex;gap:12px;align-items:flex-start;font-size:12px;line-height:1.6;margin:22px 0;cursor:pointer}.check-row input{width:16px;height:16px;accent-color:var(--accent);margin:3px 0 0;flex-shrink:0}.check-row small{display:block;color:#899780;font-size:10px;margin-top:5px}.settings-actions{display:flex;align-items:center;gap:18px;flex-wrap:wrap}.settings-divider{display:flex;gap:8px;align-items:center;border-top:1px solid var(--line);padding-top:24px;margin-top:25px;font-size:12px;color:#bfd5ab}.presets{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}.presets button{padding:10px 5px;border:1px solid #34412e;border-radius:6px;font-size:11px;color:#a4b296}.presets small{display:block;font:9px 'IBM Plex Mono',monospace;margin-top:5px}.presets button.selected{background:#2a3b21;border-color:#739254;color:#d0ebba}.settings-page .info-strip p{line-height:1.6}.settings-card .panel-heading{flex-wrap:wrap}@media(max-width:1000px){.settings-grid{grid-template-columns:1fr}}@media(max-width:500px){.settings-body{padding:17px}.settings-actions{gap:5px}.presets{gap:4px}.presets button{font-size:10px}}
`);
