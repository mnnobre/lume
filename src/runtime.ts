import {useSyncExternalStore} from "react";
import {api, type LiveView, type Session} from "./api";
import {reduceLive} from "./runtimeState";

let views = new Map<string, LiveView>();
const subscribers = new Set<()=>void>();
let startPromise: Promise<void> | undefined;
const publish=()=>subscribers.forEach(f=>f());
export function startRuntime() {
  return startPromise ??= (async()=>{
    await api.onLive(e=>{
      const k=`${e.provider}:${e.id}`;
      views=new Map(views).set(k,reduceLive(views.get(k),e)); publish();
    });
    for (const v of await api.snapshot()) {
      const k=`${v.provider}:${v.id}`;
      if ((views.get(k)?.seq??-1)<v.seq) views=new Map(views).set(k,v);
    }
    publish();
  })().catch(error=>{startPromise=undefined;throw error;});
}
export function useLiveViews() {
  return useSyncExternalStore(f=>{subscribers.add(f);return()=>{subscribers.delete(f);};},()=>views);
}
export function useLiveView(session: Pick<Session,"provider"|"id">) {
  return useLiveViews().get(`${session.provider}:${session.id}`);
}
