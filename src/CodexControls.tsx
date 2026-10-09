import {useEffect,useState} from "react";
import {api,type Model,type Skill,type Session,type TurnOptions} from "./api";

export function CodexControls({session,options,onChange,disabled,notify}:{session:Session;options:TurnOptions;onChange:(o:TurnOptions)=>void;disabled:boolean;notify:(s:string)=>void}) {
  const [models,setModels]=useState<Model[]>([]);
  const [skills,setSkills]=useState<Skill[]>([]);
  const [open,setOpen]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{let active=true;api.catalog(session.project).then(r=>{if(active){setModels(r.models);setSkills(r.skills.flatMap(x=>x.skills).filter(s=>s.enabled));}}).catch(e=>active&&setError(String(e)));return()=>{active=false;};},[session.project]);
  useEffect(()=>{if(!session.id)return;let active=true;api.manage(session.id,"read").then(r=>{if(active)onChange({model:r.thread?.model??undefined,effort:r.thread?.reasoningEffort??undefined});}).catch(e=>notify(String(e)));return()=>{active=false;};},[session.id]);
  const model=models.find(m=>m.model===options.model);
  return <div className="codex-controls">
    <select aria-label="Modelo Codex" disabled={disabled} value={options.model??""} onChange={e=>{const m=models.find(m=>m.model===e.target.value);onChange({...options,model:e.target.value||undefined,effort:m?.defaultReasoningEffort});}}><option value="">Modelo da conversa / configuração</option>{models.map(m=><option key={m.model} value={m.model}>{m.displayName}</option>)}</select>
    <select aria-label="Esforço de raciocínio" disabled={disabled||!model} value={options.effort??""} onChange={e=>onChange({...options,effort:e.target.value||undefined})}><option value="">Esforço padrão</option>{model?.supportedReasoningEfforts.map(e=><option key={e.reasoningEffort} value={e.reasoningEffort}>{e.reasoningEffort}</option>)}</select>
    <button className="btn small" disabled={disabled} onClick={()=>setOpen(!open)}>Skills{options.skills?.length?` (${options.skills.length})`:""}</button>
    {error&&<span className="hint" title={error}>Catálogo indisponível</span>}
    {open&&<div className="skills-picker">{skills.length===0?<p>Nenhuma skill disponível para esta pasta.</p>:skills.map(s=><label key={s.path} title={s.description}><input type="checkbox" checked={options.skills?.some(x=>x.path===s.path)??false} onChange={e=>onChange({...options,skills:e.target.checked?[...(options.skills??[]),{name:s.name,path:s.path}]:(options.skills??[]).filter(x=>x.path!==s.path)})}/>{s.name}</label>)}</div>}
  </div>;
}
