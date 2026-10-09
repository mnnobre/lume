import {useState} from "react";
import {api,type PendingRequest,type Session} from "./api";
import {openUrl} from "@tauri-apps/plugin-opener";

export function RequestCard({request:r,session,notify}:{request:PendingRequest;session:Session;notify:(s:string)=>void}) {
  const [values,setValues]=useState<Record<string,any>>({});
  const [busy,setBusy]=useState(false);
  const submit=async(response:unknown)=>{
    setBusy(true);
    try { if(r.kind==="approval") await api.answer(session,r.request_id,response===true);
      else await api.respond(session.id,r.request_id,response); }
    catch(e){notify(String(e));} finally {setBusy(false);}
  };
  if(r.kind==="approval") return <div className="approval"><div className="approval-text"><b>{r.tool}</b><code>{r.detail}</code></div><div className="approval-actions"><button className="btn" disabled={busy} onClick={()=>submit(false)}>Negar</button><button className="btn primary" disabled={busy} onClick={()=>submit(true)}>Permitir</button></div></div>;
  const p=r.params;
  if(r.method.includes("requestUserInput")) return <form className="request-card" onSubmit={e=>{e.preventDefault();submit({answers:Object.fromEntries((p.questions??[]).map((q:any)=>[q.id,{answers:[values[q.id]??""]}]))});}}>
    <b>O Codex precisa da sua resposta</b>
    {(p.questions??[]).map((q:any)=><label key={q.id}>{q.question}<div className="request-options">{q.options?.map((o:any)=><button type="button" className={`btn ${values[q.id]===o.label?"primary":""}`} title={o.description} key={o.label} onClick={()=>setValues(v=>({...v,[q.id]:o.label}))}>{o.label}</button>)}</div><input required type={q.isSecret?"password":"text"} value={values[q.id]??""} placeholder="Sua resposta" onChange={e=>setValues(v=>({...v,[q.id]:e.target.value}))}/></label>)}
    <button className="btn primary" disabled={busy}>Enviar respostas</button>
  </form>;
  if(r.method.includes("permissions")) return <div className="request-card"><b>Permissões adicionais</b><p>{p.reason}</p><pre>{JSON.stringify(p.permissions,null,2)}</pre><div className="request-options"><button className="btn" disabled={busy} onClick={()=>submit({allow:false})}>Negar</button><button className="btn primary" disabled={busy} onClick={()=>submit({allow:true})}>Permitir neste turno</button></div></div>;
  const fields=Object.entries(p.requestedSchema?.properties??{}) as [string,any][];
  return <form className="request-card" onSubmit={e=>{e.preventDefault();submit({action:"accept",content:p.mode==="url"?null:values});}}>
    <b>{p.serverName} precisa da sua resposta</b><p>{p.message}</p>
    {p.mode==="url" && /^https?:\/\//.test(p.url??"") && <button type="button" className="btn" onClick={()=>openUrl(p.url).catch(e=>notify(String(e)))}>Abrir página de autorização</button>}
    {fields.map(([key,s])=><label key={key}>{s.title??key}{s.description&&<small>{s.description}</small>}{s.enum?<select required={p.requestedSchema?.required?.includes(key)} value={values[key]??""} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))}><option value="">Selecione</option>{s.enum.map((o:any)=><option key={String(o)} value={String(o)}>{String(o)}</option>)}</select>:<input required={p.requestedSchema?.required?.includes(key)} type={s.type==="boolean"?"checkbox":["integer","number"].includes(s.type)?"number":s.format==="password"?"password":"text"} value={s.type==="boolean"?undefined:values[key]??""} checked={s.type==="boolean"?!!values[key]:undefined} onChange={e=>setValues(v=>({...v,[key]:s.type==="boolean"?e.target.checked:["integer","number"].includes(s.type)?Number(e.target.value):e.target.value}))}/>}</label>)}
    <div className="request-options"><button type="button" className="btn" disabled={busy} onClick={()=>submit({action:"decline",content:null})}>Recusar</button><button className="btn primary" disabled={busy}>Confirmar</button></div>
  </form>;
}
