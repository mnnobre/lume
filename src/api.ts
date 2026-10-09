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
  images?: string[];
};

export type ImageIn = { media_type: string; data: string }; // data = base64 sem prefixo

export type LiveEvent = { provider: Provider; id: string } & (
  | { kind: "delta"; text: string }
  | { kind: "tool"; name: string; title: string; detail: string }
  | { kind: "approval"; request_id: string; tool: string; detail: string }
  | { kind: "done"; error: string | null }
);

export const PROVIDERS: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

export const api = {
  listSessions: () => invoke<Session[]>("list_sessions"),
  transcript: (s: Session) => invoke<{ messages: Message[] | null }>("transcript", { provider: s.provider, id: s.id }),
  send: (s: Session, text: string, images: ImageIn[]) =>
    invoke<void>("live_send", { provider: s.provider, id: s.id, text, images }),
  answer: (s: Session, requestId: string, allow: boolean) =>
    invoke<void>("live_answer", { provider: s.provider, id: s.id, requestId, allow }),
  interrupt: (s: Session) => invoke<void>("live_interrupt", { provider: s.provider, id: s.id }),
  open: (s: Session) => invoke<void>("open_session", { provider: s.provider, id: s.id }),
  newSession: (provider: Provider, project: string) => invoke<void>("new_session", { provider, project }),
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
