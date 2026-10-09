import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ago, api, PROVIDERS, projectName, sameSession, type Provider, type Session } from "./api";
import { Chat } from "./Chat";
import "./App.css";

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
  const [version, setVersion] = useState("");
  useEffect(() => void getVersion().then(setVersion), []);
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
      <span className="ver">v{version}</span>
    </button>
  );
}

// ---------- janela ----------

function TitleBar() {
  const win = getCurrentWindow();
  return (
    <div className="titlebar" data-tauri-drag-region>
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

function NewMenu({ project, notify, onClose }: { project: string; notify: (m: string) => void; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  return (
    <div className="menu" onClick={(e) => e.stopPropagation()}>
      {(Object.keys(PROVIDERS) as Provider[]).map((p) => (
        <button
          key={p}
          onClick={() => {
            onClose();
            api.newSession(p, project).catch((e) => notify(String(e)));
          }}
        >
          <span className={`dot ${p}`} /> Nova no {PROVIDERS[p]}
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
}) {
  const { projects, query, current, select } = props;
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
      <div className="brand" data-tauri-drag-region>Lume</div>
      <div className="search">
        <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        <input value={query} onChange={(e) => props.setQuery(e.target.value)} placeholder="Buscar" />
      </div>
      <button className={`nav-item ${!current ? "active" : ""}`} onClick={() => select(null)}>
        <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        Recentes
      </button>

      <div className="section">Projetos</div>
      <nav className="tree">
        {projects.map((p) => {
          const open = expanded.has(p.path) || !!query;
          const list = showAll.has(p.path) || query ? p.sessions : p.sessions.slice(0, SHOWN);
          return (
            <div key={p.path} className="group">
              <div className="project-row" onClick={() => toggle(p.path)} title={p.path}>
                <Chevron open={open} />
                <span className="name">{projectName(p.path)}</span>
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
                {menu === p.path && <NewMenu project={p.path} notify={props.notify} onClose={() => setMenu(null)} />}
              </div>
              {open && (
                <div className="children">
                  {list.map((s) => (
                    <button key={`${s.provider}:${s.id}`} className={`leaf ${sameSession(s, current) ? "active" : ""}`} onClick={() => select(s)} title={s.title}>
                      <span className={`dot ${s.provider}`} />
                      <span className="leaf-title">{s.title}</span>
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
      <UpdateStatus {...props.update} />
    </aside>
  );
}

// ---------- recentes ----------

function Recents({ sessions, select, notify }: { sessions: Session[] | null; select: (s: Session) => void; notify: (m: string) => void }) {
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
      <header className="content-head" data-tauri-drag-region>
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
          <div key={`${s.provider}:${s.id}`} className="session" onClick={() => select(s)}>
            <span className={`dot ${s.provider}`} title={PROVIDERS[s.provider]} />
            <div className="info">
              <div className="title">{s.title}</div>
              <div className="meta">{PROVIDERS[s.provider]} · {projectName(s.project)} · {ago(s.updated)}</div>
            </div>
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

// ---------- app ----------

export default function App() {
  const update = useAutoUpdate();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<Session | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (m: string) => {
    setToast(m);
    setTimeout(() => setToast((t) => (t === m ? null : t)), 6000);
  };

  const lastLoad = useRef(0);
  const reload = () => {
    lastLoad.current = Date.now();
    api.listSessions().then(setSessions).catch((e) => notify(String(e)));
  };
  useEffect(() => {
    reload();
    // voltou para o Lume = lista fresca, no máximo a cada 30 s
    const onFocus = () => Date.now() - lastLoad.current > 30_000 && reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const sorted = useMemo(() => [...(sessions ?? [])].sort((a, b) => b.updated - a.updated), [sessions]);

  // projetos ordenados pela sessão mais recente
  const projects = useMemo(() => {
    const q = query.toLowerCase();
    const map = new Map<string, Project>();
    for (const s of sorted) {
      if (q && !`${s.project} ${s.title}`.toLowerCase().includes(q)) continue;
      const p = map.get(s.project) ?? { path: s.project, sessions: [], last: s.updated };
      p.sessions.push(s);
      map.set(s.project, p);
    }
    return [...map.values()];
  }, [sorted, query]);

  const recents = useMemo(() => {
    const q = query.toLowerCase();
    return sessions && sorted.filter((s) => !q || `${s.project} ${s.title}`.toLowerCase().includes(q));
  }, [sorted, query]);

  return (
    <div className="window">
      <TitleBar />
      <div className="shell">
        <Sidebar projects={projects} query={query} setQuery={setQuery} current={current} select={setCurrent} notify={notify} update={update} />
        <main className="content">
          {current ? <Chat key={`${current.provider}:${current.id}`} session={current} notify={notify} /> : <Recents sessions={recents} select={setCurrent} notify={notify} />}
        </main>
      </div>
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}
