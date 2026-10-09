import type { LiveEvent, LiveView } from "./api";

export function reduceLive(previous: LiveView | undefined, e: LiveEvent): LiveView {
  const empty: LiveView = {provider:e.provider,id:e.id,seq:0,busy:false,text:"",tools:[],requests:[],since:Date.now(),error:null};
  if (previous && previous.seq >= e.seq) return previous;
  const v = {...(e.kind === "started" ? empty : previous ?? empty),seq:e.seq};
  switch (e.kind) {
    case "started": return {...v,busy:true,context:previous?.context};
    case "context": return e.limit > 0 ? {...v,context:[e.used,e.limit]} : v;
    case "delta": return {...v,busy:true,item_id:e.item_id,text:(e.item_id&&e.item_id!==v.item_id?"":v.text)+e.text};
    case "tool": return {...v,busy:true,tools:[...v.tools,{role:"tool",text:e.name,title:e.title,detail:e.detail}]};
    case "approval": case "request": return {...v,busy:true,requests:[...v.requests.filter(r=>r.request_id!==e.request_id),e]};
    case "resolved": return {...v,requests:v.requests.filter(r=>r.request_id!==e.request_id)};
    case "done": return {...v,busy:false,error:e.error,requests:[]};
  }
}
