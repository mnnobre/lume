import {useEffect,useRef,useState,type CSSProperties,type PointerEvent as ReactPointerEvent,type ReactNode} from "react";
import {invoke} from "@tauri-apps/api/core";
import {LogicalSize,PhysicalPosition} from "@tauri-apps/api/dpi";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {api,projectName,type Session,type ExternalActivity,type Provider} from "./api";
import {startRuntime,useLiveViews} from "./runtime";
import "./App.css";
import "./Pet.css";

type PetState="idle"|"working"|"thinking"|"waiting"|"success"|"error"|"sleeping"|"listening"|"dragging";
type IconName="compose"|"voice"|"chats"|"close"|"open"|"stop"|"plus"|"send";
type PetAlignment="left"|"center"|"right";
type PetPlacement={alignment:PetAlignment};

function Icon({name}:{name:IconName}) {
  const paths:Record<IconName,ReactNode>={
    compose:<><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></>,
    voice:<><path d="M5 10v4M9 7v10M13 4v16M17 8v8M21 10v4"/></>,
    chats:<><path d="m7 15 5-5 5 5"/><path d="M12 10v10"/></>,
    close:<><path d="m6 6 12 12M18 6 6 18"/></>,
    open:<><path d="m9 7-5 5 5 5"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/></>,
    stop:<rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" stroke="none"/>,
    plus:<><path d="M12 5v14M5 12h14"/></>,
    send:<path d="m5 12 7-7 7 7M12 5v14"/>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export function PetSprite({state,large=false}:{state:PetState;large?:boolean}) {
  const [frame,setFrame]=useState(0);
  const [look,setLook]=useState(0);
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    setFrame(0);
    const reduced=matchMedia("(prefers-reduced-motion: reduce)");
    const tick=setInterval(()=>{if(!reduced.matches)setFrame(frame=>(frame+1)%4);},state==="working"?140:340);
    const move=(event:PointerEvent)=>{const box=ref.current?.getBoundingClientRect();if(box)setLook(Math.round(Math.atan2(event.clientY-box.top-box.height/2,event.clientX-box.left-box.width/2)/(Math.PI/8)));};
    window.addEventListener("pointermove",move);
    return()=>{clearInterval(tick);window.removeEventListener("pointermove",move);};
  },[state]);
  const row=state==="working"?1:state==="waiting"||state==="thinking"?2:state==="success"?3:0;
  const reaction=["sleeping","error","listening","dragging"].indexOf(state);
  return <div ref={ref} className={`pet-sprite pet-${state} ${large?"large":""}`} role="img" aria-label={`Mascote Lume: ${state}`} style={{backgroundImage:`url('/pet/${reaction>=0?"lume-reactions":"lume-atlas"}.png')`,backgroundPosition:`${frame*100/3}% ${(reaction>=0?reaction:row)*100/3}%`,"--look":`${Math.max(-7,Math.min(7,look))}deg`} as CSSProperties}/>;
}

const keyOf=(session:{provider:string;id:string})=>`${session.provider}:${session.id}`;
const completionSummary=(text:string|undefined)=>text?.replace(/[#*_>`\r\n]+/g," ").replace(/\s+/g," ").trim().slice(0,220)||"";

export default function Pet() {
  const [sessions,setSessions]=useState<Session[]>([]);
  const [external,setExternal]=useState<ExternalActivity[]>([]);
  const [selected,setSelected]=useState("");
  const [expanded,setExpanded]=useState(false);
  const [compose,setCompose]=useState(false);
  const [composeOptions,setComposeOptions]=useState(false);
  const [alignment,setAlignment]=useState<PetAlignment>("center");
  const [controlsVisible,setControlsVisible]=useState(false);
  const [bubbleHidden,setBubbleHidden]=useState(false);
  const [text,setText]=useState("");
  const [project,setProject]=useState("");
  const [provider,setProvider]=useState<Provider>("codex");
  const [mode,setMode]=useState<"new"|"reply">("new");
  const [sending,setSending]=useState(false);
  const [listening,setListening]=useState(false);
  const [sleeping,setSleeping]=useState(false);
  const [dragging,setDragging]=useState(false);
  const [error,setError]=useState("");
  const [now,setNow]=useState(Date.now());
  const views=useLiveViews();
  const sessionsRef=useRef<Session[]>([]);
  const previous=useRef(new Map<string,boolean>());
  const localPrevious=useRef(new Map<string,boolean>());
  const runningBefore=useRef(false);
  const composerRef=useRef<HTMLFormElement>(null);
  const stageRef=useRef<HTMLDivElement>(null);
  const contentRef=useRef<HTMLDivElement>(null);
  const draggingRef=useRef(false);
  const alignmentRef=useRef<PetAlignment>("center");
  const controlsTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const completionTimers=useRef<ReturnType<typeof setTimeout>[]>([]);
  const [completed,setCompleted]=useState<{key:string;at:number;detail:string}|null>(null);

  const recordCompletion=(key:string,detail?:string)=>{
    setCompleted({key,at:Date.now(),detail:completionSummary(detail)||"Tarefa concluída"});
    setBubbleHidden(false);
    const target=sessionsRef.current.find(session=>keyOf(session)===key);
    if(!target)return;
    const timer=setTimeout(async()=>{
      try {
        const transcript=await api.transcript(target,200);
        const finalMessage=[...(transcript.messages??[])].reverse().find(message=>message.role==="assistant"&&message.text.trim());
        const summary=completionSummary(finalMessage?.text);
        if(summary)setCompleted(current=>current?.key===key?{...current,detail:summary}:current);
      } catch { /* O resumo curto já foi registrado; o histórico pode ainda estar sendo gravado. */ }
    },350);
    completionTimers.current.push(timer);
  };

  useEffect(()=>{
    document.documentElement.classList.add("pet-document");
    startRuntime().catch(error=>setError(String(error)));
    let disposed=false;let timer:ReturnType<typeof setTimeout>;let pass=0;
    const loop=async()=>{
      try {
        if(pass++%3===0){const list=(await api.listSessions()).sort((a,b)=>b.updated-a.updated);if(!disposed){sessionsRef.current=list;setSessions(list);}}
        const activity=await api.activity();
        if(!disposed){
          for(const item of activity){const key=keyOf(item);if(previous.current.get(key)&&!item.active)recordCompletion(key,item.detail);previous.current.set(key,item.active);}
          setExternal(activity);
        }
      }catch(error){if(!disposed)setError(String(error));}
      if(!disposed)timer=setTimeout(loop,1500);
    };void loop();
    const clock=setInterval(()=>setNow(Date.now()),1000);
    return()=>{disposed=true;clearTimeout(timer);clearInterval(clock);completionTimers.current.forEach(clearTimeout);document.documentElement.classList.remove("pet-document");};
  },[]);

  useEffect(()=>{
    for(const [key,view] of views){if(localPrevious.current.get(key)&&!view.busy&&!view.error)recordCompletion(key,view.text||view.tools[view.tools.length-1]?.title);localPrevious.current.set(key,view.busy);}
  },[views]);

  useEffect(()=>{sessionsRef.current=sessions;},[sessions]);

  useEffect(()=>{alignmentRef.current=alignment;},[alignment]);

  useEffect(()=>()=>{if(controlsTimer.current)clearTimeout(controlsTimer.current);},[]);

  useEffect(()=>{
    let removeMovedListener:(()=>void)|undefined;
    let disposed=false;
    let placing=false;
    let queued=false;
    const place=async()=>{
      if(disposed)return;
      if(placing){queued=true;return;}
      placing=true;
      try {
        const result=await invoke<PetPlacement>("pet_place",{alignment:alignmentRef.current});
        alignmentRef.current=result.alignment;
        setAlignment(result.alignment);
      } catch { /* A prévia no navegador não possui a janela nativa. */ }
      finally {
        placing=false;
        if(queued){queued=false;void place();}
      }
    };
    let settle:ReturnType<typeof setTimeout>|undefined;
    try {
      getCurrentWindow().onMoved(()=>{
        // o evento dispara a cada passo do arraste: espera parar, senão a janela "pula" na sua mão
        if(settle)clearTimeout(settle);
        settle=setTimeout(()=>{if(!draggingRef.current)void place();},350);
      })
        .then(remove=>{if(disposed)remove();else removeMovedListener=remove;})
        .catch(()=>{});
    } catch { /* A prévia no navegador não possui eventos de janela do Tauri. */ }
    return()=>{disposed=true;if(settle)clearTimeout(settle);removeMovedListener?.();};
  },[]);

  const active=sessions.filter(session=>views.get(keyOf(session))?.busy||external.some(item=>keyOf(item)===keyOf(session)&&item.active));
  const recentComplete=completed&&now-completed.at<15000?sessions.find(session=>keyOf(session)===completed.key):undefined;
  const selectedSession=sessions.find(item=>keyOf(item)===selected);
  const session=active[0]??recentComplete??selectedSession??sessions[0];
  const sessionKey=session?keyOf(session):"";
  const view=session?views.get(sessionKey):undefined;
  const disk=external.find(item=>session&&keyOf(item)===sessionKey);
  const running=!!view?.busy||!!disk?.active;
  const waiting=!!view?.requests.length;
  const justCompleted=recentComplete&&session&&keyOf(recentComplete)===sessionKey;
  const state:PetState=dragging?"dragging":listening?"listening":sleeping?"sleeping":error||view?.error?"error":waiting?"waiting":running?(view?.text?"thinking":"working"):justCompleted?"success":"idle";
  const lastTool=view?.tools[view.tools.length-1];
  const detail=waiting?"Precisa da sua resposta":running?(lastTool?.title||lastTool?.detail||disk?.detail||"Executando a ação"):(justCompleted?completed?.detail||"Tarefa concluída":"Pronto para o próximo passo");
  const showBubble=!bubbleHidden&&(running||waiting||!!justCompleted||!!error||!!view?.error);
  const projects=Array.from(new Set(sessions.map(item=>item.project)));
  const currentProject=project||session?.project||projects[0]||"";

  useEffect(()=>{
    if((running&&!runningBefore.current)||(running&&sessionKey!==selected))setBubbleHidden(false);
    runningBefore.current=running;
  },[running,sessionKey,selected]);

  useEffect(()=>{
    const stage=stageRef.current,content=contentRef.current;
    if(!stage||!content)return;
    let busy=false,again=false,last=0;
    const resize=async()=>{
      if(busy){again=true;return;}
      const style=getComputedStyle(stage);
      const height=Math.max(235,Math.ceil(content.offsetHeight+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+12));
      if(height===last||draggingRef.current)return;
      busy=true;
      try {
        const win=getCurrentWindow();
        const [position,size,scale]=await Promise.all([win.outerPosition(),win.outerSize(),win.scaleFactor()]);
        const next=Math.round(height*scale);
        // base fixa: o pet fica parado e o conteúdo cresce para cima
        await win.setPosition(new PhysicalPosition(position.x,position.y+size.height-next));
        await win.setSize(new LogicalSize(360,height));
        last=height;
        const placement=await invoke<PetPlacement>("pet_place",{alignment:alignmentRef.current});
        alignmentRef.current=placement.alignment;setAlignment(placement.alignment);
      } catch(e) { console.error("pet: não consegui redimensionar a janela", e); }
      finally {busy=false;if(again){again=false;void resize();}}
    };
    const observer=new ResizeObserver(()=>void resize());
    observer.observe(content);
    return()=>observer.disconnect();
  },[]);

  useEffect(()=>{
    if(!compose)return;
    const close=(event:PointerEvent)=>{
      if(!composerRef.current?.contains(event.target as Node)){setCompose(false);setComposeOptions(false);}
    };
    let removeFocusListener:(()=>void)|undefined;
    document.addEventListener("pointerdown",close);
    try {
      getCurrentWindow().onFocusChanged(({payload:focused})=>{
        if(!focused){setCompose(false);setComposeOptions(false);}
      }).then(remove=>{removeFocusListener=remove;}).catch(()=>{});
    } catch { /* A prévia no navegador não possui eventos de janela do Tauri. */ }
    return()=>{document.removeEventListener("pointerdown",close);removeFocusListener?.();};
  },[compose]);

  const open=()=>session&&invoke("pet_open_chat",{provider:session.provider,id:session.id}).catch(error=>setError(String(error)));
  const dictate=async()=>{
    if(listening)return;setListening(true);setCompose(true);setError("");
    try {const result=await invoke<{text:string}>("pet_dictate");setText(value=>[value,result.text].filter(Boolean).join(" "));}
    catch(error){setError(String(error));}finally{setListening(false);}
  };
  const send=async()=>{
    if(!text.trim()||sending||!currentProject)return;
    setSending(true);setError("");
    try {
      await startRuntime();
      if(mode==="reply"&&session) await api.send(session,text,[]);
      else {const created=await api.newChat(provider,currentProject,text,[]);setSessions(all=>[created,...all]);setSelected(keyOf(created));}
      setText("");setCompose(false);setComposeOptions(false);
    }catch(error){setError(String(error));}finally{setSending(false);}
  };
  const drag=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button!==0)return;
    setCompose(false);setComposeOptions(false);
    event.preventDefault();event.stopPropagation();setDragging(true);draggingRef.current=true;
    try {
      getCurrentWindow().startDragging()
        .then(()=>new Promise(r=>setTimeout(r,400))) // o arraste do Windows termina depois da promessa
        .then(()=>{draggingRef.current=false;return invoke<PetPlacement>("pet_place",{alignment:alignmentRef.current});})
        .then(placement=>{alignmentRef.current=placement.alignment;setAlignment(placement.alignment);})
        .catch(error=>setError(String(error)))
        .finally(()=>{draggingRef.current=false;setDragging(false);});
    } catch(error) {
      setError(String(error));setDragging(false);
    }
  };
  const stop=()=>session&&api.interrupt(session).catch(error=>setError(String(error)));
  const showControls=()=>{
    if(controlsTimer.current)clearTimeout(controlsTimer.current);
    controlsTimer.current=null;setControlsVisible(true);
  };
  const scheduleHideControls=()=>{
    if(controlsTimer.current)clearTimeout(controlsTimer.current);
    controlsTimer.current=setTimeout(()=>{setControlsVisible(false);controlsTimer.current=null;},450);
  };

  return <div ref={stageRef} className={`pet-stage align-${alignment} state-${state} ${controlsVisible?"controls-visible":""} ${running?"is-running":""}`}><div ref={contentRef} className="pet-content">
    {error&&<div className="pet-error-box" role="alert"><span>{error}</span><button aria-label="Fechar erro" onClick={()=>setError("")}><Icon name="close"/></button></div>}
    {expanded&&<div className="pet-list"><header><b>Conversas · Lume</b><button aria-label="Fechar lista" onClick={()=>setExpanded(false)}><Icon name="close"/></button></header>{sessions.slice(0,12).map(item=><button className="pet-session" key={keyOf(item)} onClick={()=>{setSelected(keyOf(item));setExpanded(false);setBubbleHidden(false);}}><span className={`dot ${item.provider}`}/><span>{item.title}<small>{projectName(item.project)}</small></span>{active.some(entry=>keyOf(entry)===keyOf(item))&&<i className="pet-running-dot"/>}</button>)}</div>}
    {showBubble&&<div className="pet-bubble-wrap">
      <button className="pet-bubble-close" aria-label="Ocultar atividade" title="Ocultar atividade" onClick={()=>setBubbleHidden(true)}><Icon name="close"/></button>
      <div className={`pet-bubble ${running?"active":""}`}>
        <button className="pet-bubble-copy" onClick={open} disabled={!session} title="Abrir esta conversa no Lume"><b><span>{waiting?"●":running?"◌":"✓"}</span>{session?.title??"Lume"}</b><small>{listening?"Ouvindo por até 12 segundos…":detail}</small></button>
        <div className="pet-action-buttons"><button aria-label="Abrir conversa" title="Abrir conversa" onClick={open}><Icon name="open"/></button>{running&&<button aria-label="Interromper ação" title="Interromper ação" onClick={stop}><Icon name="stop"/></button>}</div>
      </div>
    </div>}
    <div className="pet-character" onPointerEnter={showControls} onPointerLeave={scheduleHideControls} onPointerDown={drag} onDoubleClick={()=>setSleeping(!sleeping)} title="Arraste somente pelo pet · Dois cliques para descansar">
      <PetSprite state={state}/>
      {running&&!sleeping&&<div className="pet-treadmill" aria-label="Esteira em movimento"><div/></div>}
      {sleeping&&<span className="pet-zzz">z z z</span>}
    </div>
    {compose?<form ref={composerRef} className="pet-composer" onSubmit={event=>{event.preventDefault();void send();}}>
      {composeOptions&&<div className="pet-compose-options"><select aria-label="Tipo de mensagem" value={mode} onChange={event=>setMode(event.target.value as "new"|"reply")}><option value="new">Novo chat</option><option value="reply" disabled={!session||running}>Responder</option></select>{mode==="new"&&<><select aria-label="Provider" value={provider} onChange={event=>setProvider(event.target.value as Provider)}><option value="codex">Codex</option><option value="claude">Claude</option></select><select aria-label="Projeto" value={currentProject} onChange={event=>setProject(event.target.value)}>{projects.map(path=><option key={path} value={path}>{projectName(path)}</option>)}</select></>}</div>}
      <div className="pet-input"><button type="button" className={composeOptions?"selected":""} aria-label="Opções do chat" title="Opções do chat" onClick={()=>setComposeOptions(!composeOptions)}><Icon name="plus"/></button><input autoFocus value={text} onChange={event=>setText(event.target.value)} placeholder={mode==="new"?"Iniciar novo chat":"Responder…"} aria-label="Mensagem"/><button className="send" disabled={sending||!text.trim()||!currentProject||(mode==="reply"&&running)} aria-label="Enviar mensagem"><Icon name="send"/></button></div>
    </form>:<div className="pet-toolbar" onPointerEnter={showControls} onPointerLeave={scheduleHideControls}><button aria-label="Novo chat" title="Novo chat" onClick={()=>{setMode("new");setCompose(true);setExpanded(false);}}><Icon name="compose"/></button><button aria-label="Ditar mensagem" title="Ditar mensagem · Português (Brasil)" disabled={listening} onClick={dictate}><Icon name="voice"/></button><span/><button aria-label="Mostrar conversas" title="Conversas" onClick={()=>{setExpanded(!expanded);setCompose(false);}}><Icon name="chats"/></button><button aria-label="Ocultar pet" title="Ocultar pet" onClick={()=>{localStorage.setItem("lume.pet.enabled","off");invoke("pet_toggle",{enabled:false}).catch(error=>setError(String(error)));}}><Icon name="close"/></button></div>}
  </div></div>;
}
