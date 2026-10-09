import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Provider = "claude" | "codex" | "antigravity";

export type Session = {
  provider: Provider;
  id: string;
  project: string;
  title: string;
  updated: number; // ms
};

/** role "tool": text = nome, title = o que o agente disse que ia fazer, detail = resumo, input/output = ao expandir. */
export type Message = {
  role: "user" | "assistant" | "tool";
  text: string;
  title?: string;
  detail?: string;
  input?: string;
  output?: string;
  failed?: boolean;
  added?: number; // linhas +/− das edições
  removed?: number;
  images?: string[];
};

export type Harness = {
  id: string;
  name: string;
  installed: string | null;
  latest: string | null;
  detail: string | null;
  auto: boolean; // o próprio app se atualiza
  can_update: boolean; // o Lume atualiza (CLI)
  outdated: boolean;
};

export type UsageWindow = { label: string; used: number; resets_at: number | null };
export type UsageReport = { provider: Provider; plan: string | null; windows: UsageWindow[]; error: string | null };

export type ImageIn = { media_type: string; data: string }; // data = base64 sem prefixo

export type LiveEvent = { provider: Provider; id: string; seq: number } & (
  | { kind: "started" }
  | { kind: "request"; request_id: string; method: string; params: Record<string, any> }
  | { kind: "resolved"; request_id: string }
  | { kind: "delta"; text: string; item_id?: string | null }
  | { kind: "tool"; name: string; title: string; detail: string }
  | { kind: "approval"; request_id: string; tool: string; detail: string }
  | { kind: "done"; error: string | null }
);

export type PendingRequest = Extract<LiveEvent, {kind: "approval" | "request"}>;
export type LiveView = {provider: Provider; id: string; seq: number; busy: boolean; text: string; tools: Message[]; requests: PendingRequest[]; since: number; error: string | null; item_id?: string | null};
export type TurnOptions = { model?: string; effort?: string; skills?: {name: string; path: string}[] };
export type Transcript = {messages: Message[] | null; updated: number; revision: string; active: boolean; activity: string; has_more: boolean; model?: string};
export type SearchHit = {provider: Provider; id: string; snippet: string};
export type ExternalActivity = {provider: Provider; id: string; active: boolean; detail: string; updated: number};
export type Model = {model: string; displayName: string; defaultReasoningEffort: string; supportedReasoningEfforts: {reasoningEffort: string; description: string}[]};
export type Skill = {name: string; path: string; description: string; enabled: boolean};

export const PROVIDERS: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

export const api = {
  listSessions: (archived = false) => invoke<Session[]>("list_sessions", {archived}),
  transcript: (s: Session, limit = 400) => invoke<Transcript>("transcript", { provider: s.provider, id: s.id, limit }),
  send: (s: Session, text: string, images: ImageIn[], options?: TurnOptions) =>
    invoke<void>("live_send", { provider: s.provider, id: s.id, text, images, options }),
  answer: (s: Session, requestId: string, allow: boolean) =>
    invoke<void>("live_answer", { provider: s.provider, id: s.id, requestId, allow }),
  interrupt: (s: Session) => invoke<void>("live_interrupt", { provider: s.provider, id: s.id }),
  open: (s: Session) => invoke<void>("open_session", { provider: s.provider, id: s.id }),
  openFolder: (project: string) => invoke<void>("open_folder", { project }),
  newSession: (provider: Provider, project: string) => invoke<void>("new_session", { provider, project }),
  newChat: (provider: Provider, project: string, text: string, images: ImageIn[], options?: TurnOptions) =>
    invoke<Session>("live_new", { provider, project, text, images, options }),
  snapshot: () => invoke<LiveView[]>("live_snapshot"),
  activity: () => invoke<ExternalActivity[]>("session_activity"),
  respond: (id: string, requestId: string, response: unknown) => invoke<void>("live_respond", {id, requestId, response}),
  catalog: (project: string) => invoke<{models: Model[]; skills: {skills: Skill[]}[]}>("codex_catalog", {project}),
  manage: (id: string, action: "read" | "rename" | "archive" | "unarchive", name?: string) => invoke<any>("codex_manage", {id, action, name}),
  harness: () => invoke<Harness[]>("harness_versions"),
  updateHarness: (id: string) => invoke<string>("update_harness", { id }),
  search: (query: string) => invoke<SearchHit[]>("search_content", { query }),
  usage: () => invoke<UsageReport[]>("usage"),
  onLive: (cb: (e: LiveEvent) => void) => listen<LiveEvent>("live", (e) => cb(e.payload)),
};

const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
export function ago(ms: number) {
  const s = (ms - Date.now()) / 1000;
  for (const [unit, size] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const)
    if (Math.abs(s) >= size) return rtf.format(Math.round(s / size), unit);
  return "agora";
}

export const projectName = (path: string) => path.split("\\").filter(Boolean).pop() ?? path;

export const sameSession = (a: { provider: string; id: string } | null, b: { provider: string; id: string } | null) =>
  !!a && !!b && a.provider === b.provider && a.id === b.id;
