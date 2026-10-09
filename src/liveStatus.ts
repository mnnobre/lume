import { useSyncExternalStore } from "react";
import { api, type Provider } from "./api";

/**
 * Quais conversas estão rodando agora (e se estão esperando você), para a barra lateral,
 * Recentes e a linha de status do chat. Um único ouvinte do evento "live" para o app todo.
 */
export type Activity = {
  state: "working" | "waiting"; // waiting = pedido de aprovação aberto
  since: number; // ms, início do turno
  stepSince: number; // ms, início do passo atual (o contador da linha ao vivo)
  doing: string; // o que está fazendo agora: a descrição da ferramenta, "Pensando…", "Escrevendo…"
};

const key = (provider: Provider | string, id: string) => `${provider}:${id}`;
let map = new Map<string, Activity>();
const subs = new Set<() => void>();
const set = (k: string, a: Activity | null) => {
  map = new Map(map);
  a ? map.set(k, a) : map.delete(k);
  subs.forEach((f) => f());
};

/** Frase curta para a ferramenta em uso, no estilo do Claude. */
export function doingFor(tool: string) {
  if (["Bash", "PowerShell", "Comando"].includes(tool)) return "Executando um comando";
  if (tool === "Read") return "Lendo um arquivo";
  if (["Edit", "MultiEdit", "Write", "Editar arquivos", "NotebookEdit"].includes(tool)) return "Editando arquivos";
  if (["Grep", "Glob"].includes(tool)) return "Buscando no código";
  if (["WebSearch", "WebFetch", "Busca na web"].includes(tool)) return "Pesquisando na web";
  if (tool === "Task" || tool === "Agent") return "Delegando a um agente";
  return `Usando ${tool}`;
}

let started = false;
function start() {
  if (started) return;
  started = true;
  api.onLive((e) => {
    const k = key(e.provider, e.id);
    const now = Date.now();
    const cur = map.get(k) ?? { state: "working" as const, since: now, stepSince: now, doing: "Pensando…" };
    const step = (state: Activity["state"], doing: string) => set(k, { ...cur, state, doing, stepSince: now });
    if(e.kind==="started") return set(k,{state:"working",since:now,stepSince:now,doing:"Pensando…"});
    if(e.kind==="request") return step("waiting","Aguardando sua resposta");
    if(e.kind==="resolved") return step("working","Trabalhando…");
    if (e.kind === "done") return set(k, null);
    if (e.kind === "approval") return step("waiting", `Aguardando sua aprovação: ${e.tool}`);
    // a descrição que o agente deu ao passo (ex.: description do Bash), como o Claude mostra
    if (e.kind === "tool") return step("working", e.title || (e.detail ? `${doingFor(e.name)} · ${e.detail}` : doingFor(e.name)));
    if (e.kind === "delta" && cur.doing !== "Escrevendo…") return step("working", "Escrevendo…");
  });
  api.snapshot().then(views=>{for(const v of views) if(v.busy&&!map.has(key(v.provider,v.id)))set(key(v.provider,v.id),{state:v.requests.length?"waiting":"working",since:v.since,stepSince:v.since,doing:v.requests.length?"Aguardando sua resposta":"Trabalhando…"});}).catch(()=>{});
}

/** Chamado ao enviar: a conversa já aparece como "rodando" antes do primeiro evento. */
export const markWorking = (provider: Provider, id: string) =>
  set(key(provider, id), { state: "working", since: Date.now(), stepSince: Date.now(), doing: "Pensando…" });
export const markIdle = (provider: Provider, id: string) => set(key(provider, id), null);
export const markWorkingAgain = (provider: Provider, id: string) => {
  const cur = map.get(key(provider, id));
  if (cur) set(key(provider, id), { ...cur, state: "working", doing: "Pensando…", stepSince: Date.now() });
};

export function useActivity() {
  start();
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => map,
  );
}

export const activityOf = (m: Map<string, Activity>, s: { provider: string; id: string }) => m.get(key(s.provider, s.id));
