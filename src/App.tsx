import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ago, api, PROVIDERS, projectName, sameSession, type Provider, type Session, type UsageReport } from "./api";
import { activityOf, useActivity, type Activity } from "./liveStatus";
import { Chat } from "./Chat";
import { useFocus, type FocusApi } from "./focus";
import { Settings, type Section } from "./Settings";
import { useHarness, type HarnessApi } from "./harness";
import { useNotificationsSetting, useTurnNotifications } from "./notify";
import "./App.css";
import {listen} from "@tauri-apps/api/event";
import {startRuntime} from "./runtime";

// ---------- atualização automática ----------

type UpdateState =
  | { kind: "dev" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

function useAutoUpdate() {
  // até a 1.0 o desenvolvimento é local (tauri dev); a checagem só roda no app instalado
  const [state, setState] = useState<UpdateState>(import.meta.env.DEV ? { kind: "dev" } : { kind: "checking" });
  const started = useRef(false); // StrictMode roda o efeito 2x

  async function run() {
    if (import.meta.env.DEV) return;
    setState({ kind: "checking" });
    try {
      const update = await invoke<{ version: string } | null>("check_update");
      if (!update) return setState({ kind: "current" });
      setState({ kind: "installing", version: update.version });
      await invoke("install_update"); // instala e reinicia
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      run();
    }
  }, []);
  return { state, retry: run };
}

function UpdateStatus({ state, retry }: ReturnType<typeof useAutoUpdate>) {
  const label = {
    dev: "Desenvolvimento",
    checking: "Procurando atualizações…",
    current: "Atualizado",
    installing: state.kind === "installing" ? `Atualizando para ${state.version}…` : "",
    error: "Sem verificação de atualização",
  }[state.kind];
  return (
    <button
      className={`update ${state.kind}`}
      onClick={state.kind === "current" || state.kind === "error" ? retry : undefined}
      title={state.kind === "error" ? state.message : undefined}
    >
      <span className="dot" />
      <span>{label}</span>
    </button>
  );
}

// ---------- uso das IAs (5 h / semanal) ----------

let usageCache: { at: number; data: UsageReport[] } | null = null;

function untilText(ms: number | null) {
  if (!ms) return "";
  const min = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (min < 60) return `reinicia em ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `reinicia em ${h} h ${min % 60 ? `${min % 60} min` : ""}`.trim();
  return `reinicia em ${Math.round(h / 24)} d`;
}

const heat = (used: number) => (used >= 90 ? "hot" : used >= 70 ? "warm" : "");

/** Anel com o % usado (fechado). */
function Ring({ used }: { used: number }) {
  const r = 6.5, c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${heat(used)}`} width="17" height="17" viewBox="0 0 17 17" aria-hidden>
      <circle cx="8.5" cy="8.5" r={r} className="ring-track" />
      <circle cx="8.5" cy="8.5" r={r} className="ring-fill" strokeDasharray={`${(Math.min(100, used) / 100) * c} ${c}`} />
    </svg>
  );
}

function UsageProvider({ r }: { r: UsageReport }) {
  const [open, setOpen] = useState(() => load<string[]>("lume.usageOpen", []).includes(r.provider));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    const cur = new Set(load<string[]>("lume.usageOpen", []));
    next ? cur.add(r.provider) : cur.delete(r.provider);
    save("lume.usageOpen", [...cur]);
  };
  // fechado: a janela de 5 h do grupo principal (Sessão no Claude, 5 horas no Codex, Gemini no Antigravity);
  // a semanal e os grupos secundários ficam no detalhe
  const top = r.windows.find((w) => !/seman/i.test(w.label)) ?? r.windows[0] ?? null;
  return (
    <div className={`usage-provider ${open ? "open" : ""}`}>
      <button
        className="usage-head"
        onClick={toggle}
        title={top ? `${top.label}: ${Math.round(top.used)}% · ${untilText(top.resets_at)}` : r.error ?? undefined}
      >
        <span className={`dot ${r.provider}`} />
        <span className="usage-name">{PROVIDERS[r.provider]}</span>
        {r.plan && <span className="plan">{r.plan[0].toUpperCase() + r.plan.slice(1)}</span>}
        <span className="grow" />
        {top ? (
          <>
            <Ring used={top.used} />
            <span className={`usage-pct ${heat(top.used)}`}>{Math.round(top.used)}%</span>
          </>
        ) : (
          <span className="usage-off">indisponível</span>
        )}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="usage-detail">
          {r.error && <p className="usage-error">{r.error}</p>}
          {r.windows.map((w) => (
            <div key={w.label} className="usage-row">
              <div className="usage-label">
                <span>{w.label}</span>
                <span className={`usage-pct ${heat(w.used)}`}>{Math.round(w.used)}%</span>
              </div>
              <div className="bar"><span className={heat(w.used)} style={{ width: `${Math.min(100, w.used)}%` }} /></div>
              <div className="usage-reset">{untilText(w.resets_at)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Usage() {
  const [data, setData] = useState<UsageReport[] | null>(usageCache?.data ?? null);
  const [loading, setLoading] = useState(false);
  const load = (force = false) => {
    if (!force && usageCache && Date.now() - usageCache.at < 60_000) return; // no máximo 1x por minuto
    setLoading(true);
    api
      .usage()
      .then((d) => {
        usageCache = { at: Date.now(), data: d };
        setData(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => load(), []);

  return (
    <div className="usage">
      <div className="menu-row">
        <span className="menu-title">Uso</span>
        <button className="icon-btn small" onClick={() => load(true)} title="Atualizar" aria-label="Atualizar uso">
          <svg className={loading ? "spin" : ""} width="12" height="12" viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
      {!data && <p className="hint small">Carregando…</p>}
      {data?.map((r) => <UsageProvider key={r.provider} r={r} />)}
    </div>
  );
}

// ---------- rodapé: menu com Modo Foco rápido e Configurações (como o menu de conta do Claude) ----------

/** Pet flutuante: liga/desliga e lembra a escolha (ele volta sozinho ao abrir o Lume). */
function PetToggle() {
  const [on, setOn] = useState(() => localStorage.getItem("lume.pet.enabled") !== "off");
  const toggle = () => {
    const next = !on;
    setOn(next);
    localStorage.setItem("lume.pet.enabled", next ? "on" : "off");
    invoke("pet_toggle", { enabled: next }).catch(() => setOn(!next));
  };
  return (
    <div className="menu-row">
      <span className="menu-title">Pet do Lume</span>
      <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label="Pet do Lume" onClick={toggle}>
        <span />
      </button>
    </div>
  );
}

function FooterMenu({ focus, update, openSettings, harness }: {
  focus: FocusApi;
  update: ReturnType<typeof useAutoUpdate>;
  openSettings: (section?: Section) => void;
  harness: HarnessApi;
}) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState("");
  useEffect(() => void getVersion().then(setVersion), []);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  const { focus: f, active } = focus;

  return (
    <div className="footer" onClick={(e) => e.stopPropagation()}>
      {open && (
        <div className="footer-menu">
          <div className="menu-row">
            <span className="menu-title">Modo Foco</span>
            <button className={`toggle ${f.enabled ? "on" : ""}`} role="switch" aria-checked={f.enabled} aria-label="Modo Foco"
              onClick={() => (f.profiles.length ? focus.setEnabled(!f.enabled) : (setOpen(false), openSettings()))}>
              <span />
            </button>
          </div>
          {f.profiles.map((p) => (
            <button key={p.id} className="menu-item" onClick={() => focus.use(active?.id === p.id ? null : p.id)}>
              <span className="grow">{p.name}</span>
              <span className="count">{p.projects.length}</span>
              <span className="check-right">{active?.id === p.id ? "✓" : ""}</span>
            </button>
          ))}
          <button className="menu-item muted" onClick={() => (setOpen(false), openSettings())}>
            <span className="grow">{f.profiles.length ? "Editar perfis…" : "Criar um perfil…"}</span>
          </button>
          <PetToggle />
          <div className="menu-sep" />
          <Usage />
          {update.state.kind !== "dev" && (
            <>
              <div className="menu-sep" />
              <UpdateStatus {...update} />
            </>
          )}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => (setOpen(false), openSettings("focus"))}>
            <svg className="check" width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            <span className="grow">Configurações</span>
            <kbd>Ctrl+,</kbd>
          </button>
        </div>
      )}
      <button className={`footer-btn ${open ? "open" : ""}`} onClick={() => setOpen(!open)}>
        <span className="avatar">L</span>
        <span className="grow">Lume <span className="ver">v{version}</span></span>
        {active && <span className="focus-chip">{active.name}</span>}
        {harness.outdated > 0 && <span className="dot update-dot" title="Há atualização de harness" />}
        <svg className={`chev up ${open ? "open" : ""}`} width="10" height="10" viewBox="0 0 10 10"><path d="M2 6.5l3-3 3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );
}

// ---------- janela ----------

/**
 * Arrastar a janela por qualquer área marcada com data-drag (cabeçalhos), menos botões/campos/links.
 * Duplo clique maximiza/restaura, como na barra do Windows. Feito à mão porque o data-tauri-drag-region
 * só funciona quando o clique cai no próprio elemento, não nos filhos (título, subtítulo…).
 */
function useWindowDrag() {
  useEffect(() => {
    const win = getCurrentWindow();
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (e.button !== 0 || !t.closest("[data-drag]") || t.closest("button, input, textarea, select, a, [data-no-drag]")) return;
      e.preventDefault();
      e.detail === 2 ? win.toggleMaximize() : win.startDragging();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);
}

function TitleBar() {
  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-drag>
      <div className="controls">
        <button onClick={() => win.minimize()} aria-label="Minimizar">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button onClick={() => win.toggleMaximize()} aria-label="Maximizar">
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button className="close" onClick={() => win.close()} aria-label="Fechar">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chev ${open ? "open" : ""}`} width="10" height="10" viewBox="0 0 10 10">
    <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ---------- persistência leve (por máquina) ----------

const load = <T,>(k: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "") as T;
  } catch {
    return fallback;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

// ---------- barra lateral ----------

type Project = { path: string; sessions: Session[]; last: number };
const SHOWN = 8;

/** Ponto da conversa: girando = IA trabalhando, laranja pulsando = esperando você. */
function SessionDot({ s, activity }: { s: Session; activity?: Activity }) {
  if (activity?.state === "working") return <span className="spinner small" title={activity.doing} />;
  if (activity?.state === "waiting") return <span className="dot waiting" title="Aguardando sua aprovação" />;
  return <span className={`dot ${s.provider}`} />;
}

function NewMenu({ project, notify, onClose, startDraft }: {
  project: string;
  notify: (m: string) => void;
  onClose: () => void;
  startDraft: (provider: Provider, project: string) => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  const inApp = (p: Provider) => {
    onClose();
    api.newSession(p, project).catch((e) => notify(String(e)));
  };
  return (
    <div className="menu" onClick={(e) => e.stopPropagation()}>
      <div className="menu-label">Nova conversa no Lume</div>
      {(["claude", "codex", "antigravity"] as Provider[]).map((p) => (
        <button key={p} onClick={() => (onClose(), startDraft(p, project))}>
          <span className={`dot ${p}`} /> {PROVIDERS[p]}
        </button>
      ))}
      <div className="menu-sep" />
      <div className="menu-label">Abrir no app</div>
      {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
        <button key={p} onClick={() => inApp(p)}>
          <span className={`dot ${p}`} /> {PROVIDERS[p]}
        </button>
      ))}
    </div>
  );
}

function Sidebar(props: {
  projects: Project[];
  query: string;
  setQuery: (q: string) => void;
  current: Session | null;
  select: (s: Session | null) => void;
  notify: (m: string) => void;
  update: ReturnType<typeof useAutoUpdate>;
  focus: FocusApi;
  openSettings: (section?: Section) => void;
  startDraft: (provider: Provider, project: string) => void;
  harness: HarnessApi;
  unread: (s: Session) => boolean;
  searching: boolean;
}) {
  const { projects, query, current, select, focus } = props;
  const activity = useActivity();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(load<string[]>("lume.expanded", [])));
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);

  const toggle = (path: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      next.has(path) ? next.delete(path) : next.add(path);
      save("lume.expanded", [...next]);
      return next;
    });

  // a sessão aberta sempre fica visível na barra
  useEffect(() => {
    if (current && !expanded.has(current.project)) toggle(current.project);
  }, [current?.project]);

  return (
    <aside className="sidebar">
      <div className="brand" data-drag>Lume</div>
      <div className="search">
        <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <input value={query} onChange={(e) => props.setQuery(e.target.value)} placeholder="Buscar" />
      </div>
      <button className={`nav-item ${!current ? "active" : ""}`} onClick={() => select(null)}>
        <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        Recentes
      </button>

      {props.searching && <div className="search-state">Buscando dentro das conversas…</div>}
      <div className="section">
        Projetos
        {focus.active && (
          <button className="focus-pill" onClick={() => focus.use(null)} title="Desligar o Modo Foco">
            Foco: {focus.active.name} <span>×</span>
          </button>
        )}
      </div>
      <nav className="tree">
        {focus.active && !projects.length && (
          <p className="hint small">Nenhum projeto neste foco. <button className="link" onClick={() => props.openSettings("focus")}>Escolher projetos</button></p>
        )}
        {projects.map((p) => {
          const open = expanded.has(p.path) || !!query;
          const list = showAll.has(p.path) || query ? p.sessions : p.sessions.slice(0, SHOWN);
          return (
            <div key={p.path} className="group">
              <div className="project-row" onClick={() => toggle(p.path)} title={p.path}>
                <Chevron open={open} />
                <span className="name">{projectName(p.path)}</span>
                {p.sessions.some((s) => activityOf(activity, s)) && <span className="spinner small" title="Uma IA está trabalhando aqui" />}
                <span className="count">{p.sessions.length}</span>
                <button
                  className="add"
                  aria-label="Nova sessão"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === p.path ? null : p.path);
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
                {menu === p.path && <NewMenu project={p.path} notify={props.notify} onClose={() => setMenu(null)} startDraft={props.startDraft} />}
              </div>
              {open && (
                <div className="children">
                  {list.map((s) => (
                    <button key={`${s.provider}:${s.id}`} className={`leaf ${sameSession(s, current) ? "active" : ""} ${props.unread(s) ? "unread" : ""}`} onClick={() => select(s)} title={s.title}>
                      <SessionDot s={s} activity={activityOf(activity, s)} />
                      <span className="leaf-title">{s.title}</span>
                      {props.unread(s) && !activityOf(activity, s) && <span className="unread-dot" title="Terminou enquanto você estava em outra conversa" />}
                    </button>
                  ))}
                  {!query && p.sessions.length > SHOWN && (
                    <button
                      className="more"
                      onClick={() =>
                        setShowAll((cur) => {
                          const next = new Set(cur);
                          next.has(p.path) ? next.delete(p.path) : next.add(p.path);
                          return next;
                        })
                      }
                    >
                      {showAll.has(p.path) ? "Mostrar menos" : `Mostrar mais ${p.sessions.length - SHOWN}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <FooterMenu focus={focus} update={props.update} openSettings={props.openSettings} harness={props.harness} />
    </aside>
  );
}

// ---------- recentes ----------

function Recents({ sessions, select, notify, unread, hits }: {
  sessions: Session[] | null;
  select: (s: Session) => void;
  notify: (m: string) => void;
  unread: (s: Session) => boolean;
  hits: Map<string, string>;
}) {
  const activity = useActivity();
  const [providers, setProviders] = useState<Set<Provider>>(new Set(["claude", "codex", "antigravity"]));
  const list = (sessions ?? []).filter((s) => providers.has(s.provider)).slice(0, 150);
  const toggle = (p: Provider) =>
    setProviders((cur) => {
      const next = new Set(cur);
      next.has(p) && next.size > 1 ? next.delete(p) : next.add(p);
      return next;
    });
  return (
    <section className="recents">
      <div className="drag-strip" data-drag />
      <header className="content-head" data-drag>
        <div>
          <h1>Recentes</h1>
          <p className="sub">Claude Code, Codex e Antigravity, juntos.</p>
        </div>
        <div className="filters">
          {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
            <button key={p} className={`chip ${p} ${providers.has(p) ? "on" : ""}`} onClick={() => toggle(p)}>
              <span className="dot" />
              {PROVIDERS[p]}
            </button>
          ))}
        </div>
      </header>
      <div className="sessions">
        {!sessions && <p className="hint">Carregando sessões…</p>}
        {sessions && !list.length && <p className="hint">Nada encontrado.</p>}
        {list.map((s) => (
          <div key={`${s.provider}:${s.id}`} className={`session ${unread(s) ? "unread" : ""}`} onClick={() => select(s)}>
            <SessionDot s={s} activity={activityOf(activity, s)} />
            <div className="info">
              <div className="title">{s.title}</div>
              <div className="meta">
                {PROVIDERS[s.provider]} · {projectName(s.project)} · {activityOf(activity, s)?.doing ?? ago(s.updated)}
              </div>
              {hits.get(`${s.provider}:${s.id}`) && <div className="hit">“{hits.get(`${s.provider}:${s.id}`)}”</div>}
            </div>
            {unread(s) && !activityOf(activity, s) && <span className="unread-dot" />}
            <button
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                api.open(s).catch((err) => notify(String(err)));
              }}
            >
              Abrir no app
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- Ctrl+K ----------

function Palette({ sessions, onPick, onClose }: { sessions: Session[]; onPick: (s: Session) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return sessions.filter((s) => words.every((w) => `${s.title} ${projectName(s.project)} ${PROVIDERS[s.provider]}`.toLowerCase().includes(w))).slice(0, 50);
  }, [q, sessions]);
  useEffect(() => setI(0), [q]);
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          placeholder="Ir para conversa ou projeto…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(x + 1, list.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(x - 1, 0)));
            else if (e.key === "Enter" && list[i]) onPick(list[i]);
          }}
        />
        <div className="palette-list">
          {list.map((s, n) => (
            <button key={`${s.provider}:${s.id}`} className={`palette-item ${n === i ? "on" : ""}`} onMouseEnter={() => setI(n)} onClick={() => onPick(s)}>
              <span className={`dot ${s.provider}`} />
              <div className="info">
                <div className="title">{s.title}</div>
                <div className="meta">{projectName(s.project)} · {ago(s.updated)}</div>
              </div>
            </button>
          ))}
          {!list.length && <p className="hint">Nada encontrado.</p>}
        </div>
      </div>
    </div>
  );
}

// ---------- app ----------

export default function App() {
  useWindowDrag();
  const update = useAutoUpdate();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<Session | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [settings, setSettings] = useState<Section | null>(null);
  const [collapsed, setCollapsed] = useState(() => load<boolean>("lume.sidebarCollapsed", false));
  const toggleSidebar = () => setCollapsed((c) => (save("lume.sidebarCollapsed", !c), !c));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [archived,setArchived] = useState(false);
  const [pins,setPins] = useState<string[]>(()=>load("lume.pins",[]));
  const togglePin=(s:Session)=>setPins(old=>{const key=`${s.provider}:${s.id}`;const next=old.includes(key)?old.filter(k=>k!==key):[...old,key];localStorage.setItem("lume.pins",JSON.stringify(next));return next;});
  const harness = useHarness((m) => notify(m));
  const notifications = useNotificationsSetting();
  const focus = useFocus();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setSettings("focus");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const notify = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 6000);
  };

  const reloadRef=useRef<()=>void>(()=>{});
  useEffect(() => {
    let disposed=false,loading=false;
    let timer:ReturnType<typeof setTimeout>;
    const reload=async()=>{
      if(loading||disposed)return;loading=true;
      try {const list=await api.listSessions(archived);if(!disposed){setSessions(list);setCurrent(c=>c?.id?list.find(s=>sameSession(s,c))??null:c);}}
      catch(e){if(!disposed)notify(String(e));}finally{loading=false;}
    };
    reloadRef.current=()=>void reload();
    const loop=async()=>{await reload();if(!disposed)timer=setTimeout(loop,4000);};void loop();
    const onFocus=()=>void reload();window.addEventListener("focus",onFocus);
    return()=>{disposed=true;clearTimeout(timer);window.removeEventListener("focus",onFocus);};
  }, [archived]);
  useEffect(()=>{
    startRuntime().catch(e=>notify(String(e)));
    const selected=listen<{provider:string;id:string}>("pet-open-chat",async e=>{
      setArchived(false);
      try {const list=await api.listSessions();setSessions(list);setCurrent(list.find(s=>sameSession(s,e.payload))??null);}catch(error){notify(String(error));}
    });
    let previous="";
    const errors=listen<string>("provider-error",e=>{if(e.payload!==previous){previous=e.payload;notify(e.payload);}});
    if(localStorage.getItem("lume.pet.enabled")!=="off") invoke("pet_toggle",{enabled:true}).catch(e=>notify(String(e)));
    return()=>{void selected.then(f=>f());void errors.then(f=>f());};
  },[]);

  useTurnNotifications(notifications.on, sessions);

  // 5. não lidas: a conversa mudou depois da última vez que você a abriu
  const [seen, setSeen] = useState<Record<string, number>>(() => load("lume.seen", {}));
  const [baseline] = useState(() => {
    const b = load<number>("lume.seenBaseline", 0) || Date.now(); // primeira vez: nada conta como não lido
    save("lume.seenBaseline", b);
    return b;
  });
  useEffect(() => {
    if (!current?.id) return;
    const k = `${current.provider}:${current.id}`;
    setSeen((old) => {
      const next = { ...old, [k]: Math.max(Date.now(), current.updated) };
      save("lume.seen", next);
      return next;
    });
  }, [current?.provider, current?.id, current?.updated]);
  const unread = (s: Session) => !sameSession(s, current) && s.updated > (seen[`${s.provider}:${s.id}`] ?? baseline);

  // 8. busca dentro das conversas (a partir de 3 letras, espera você parar de digitar)
  const [hits, setHits] = useState<Map<string, string>>(new Map());
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) return setHits(new Map());
    let alive = true;
    const t = setTimeout(() => {
      setSearching(true);
      api
        .search(q)
        .then((r) => alive && setHits(new Map(r.map((h) => [`${h.provider}:${h.id}`, h.snippet]))))
        .catch(() => {})
        .finally(() => alive && setSearching(false));
    }, 450);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);
  const matches = (s: Session, q: string) => !q || `${s.project} ${s.title}`.toLowerCase().includes(q) || hits.has(`${s.provider}:${s.id}`);

  // 7. Ctrl+K: pular para qualquer conversa
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const allSorted = useMemo(() => [...(sessions ?? [])].sort((a, b) => Number(pins.includes(`${b.provider}:${b.id}`))-Number(pins.includes(`${a.provider}:${a.id}`)) || b.updated-a.updated), [sessions,pins]);
  // Modo Foco: só os projetos do perfil ativo
  const sorted = useMemo(() => allSorted.filter((s) => focus.visible(s.project)), [allSorted, focus.focus]);

  // todos os projetos (sem foco), para escolher nas configurações
  const allProjects = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allSorted) m.set(s.project, (m.get(s.project) ?? 0) + 1);
    return [...m.entries()].map(([path, count]) => ({ path, count }));
  }, [allSorted]);

  // projetos ordenados pela sessão mais recente
  const projects = useMemo(() => {
    const q = query.toLowerCase();
    const map = new Map<string, Project>();
    for (const s of sorted) {
      if (!matches(s, q)) continue;
      const p = map.get(s.project) ?? { path: s.project, sessions: [], last: s.updated };
      p.sessions.push(s);
      map.set(s.project, p);
    }
    return [...map.values()];
  }, [sorted, query, hits]);

  const recents = useMemo(() => {
    const q = query.toLowerCase();
    return sessions && sorted.filter((s) => matches(s, q));
  }, [sorted, query, hits]);

  return (
    <div className="window">
      <TitleBar />
      <button className="sidebar-toggle icon-btn" onClick={toggleSidebar} title={`${collapsed ? "Mostrar" : "Ocultar"} barra lateral (Ctrl+B)`} aria-label="Alternar barra lateral">
        <svg width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" /></svg>
      </button>
      <div className={`shell ${collapsed ? "collapsed" : ""}`}>
        <Sidebar projects={projects} query={query} setQuery={setQuery} current={current} select={setCurrent} notify={notify} update={update}
          focus={focus} openSettings={(sec) => setSettings(sec ?? "focus")} harness={harness}
          startDraft={(provider, project) => setCurrent({ provider, project, id: "", title: "Nova conversa", updated: Date.now() })}
          unread={unread} searching={searching} />
        <main className="content">
          {current ? (
            <Chat
              key={`${current.provider}:${current.id || "nova:" + current.project}`}
              session={current}
              archived={archived}
              pinned={pins.includes(`${current.provider}:${current.id}`)}
              onPin={()=>togglePin(current)}
              onChanged={()=>reloadRef.current()}
              notify={notify}
              onCreated={(s) => {
                setCurrent(s); // a conversa nova vira uma sessão de verdade
                setSessions((all) => [s, ...(all ?? []).filter((x) => !sameSession(x, s))]);
              }}
            />
          ) : (
            <Recents sessions={recents} select={setCurrent} notify={notify} unread={unread} hits={hits} />
          )}
        </main>
      </div>
      {settings && (
        <Settings onClose={() => setSettings(null)} focus={focus} projects={allProjects} harness={harness}
          notifications={notifications} initial={settings} notify={notify} />
      )}
      {palette && <Palette sessions={allSorted} onPick={(s) => (setCurrent(s), setPalette(false))} onClose={() => setPalette(false)} />}
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
