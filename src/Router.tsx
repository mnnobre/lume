import { useEffect, useMemo, useRef, useState } from "react";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { api, ago, PROVIDERS, projectName, sameSession, type Model, type Provider, type Session, type UsageReport } from "./api";
import { Chat, saveOpts } from "./Chat";
import { ProviderIcon } from "./ProviderIcon";
import { ANTIGRAVITY_MODELS, CLAUDE_MODELS } from "./ModelSelector";
import { activityOf, useActivity } from "./liveStatus";
import { heat, Ring, useUsage } from "./usage";
import { DEFAULT_CONFIG, destKey, handoffText, LEVELS, overCeiling, quota, route, withDefaults, type Level, type RouterConfig, type Target } from "./routing";
import { accountName, useClaudeAccounts, useAntigravityAccounts } from "./accounts";

// ---------- estado salvo ----------

const read = <T,>(k: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "") as T;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

/** Tarefa que o roteador mandou para algum provider (histórico deste contexto). */
type Routed = { provider: Provider; id: string; project: string; title: string; request: string; level: Level; reason: string; target: Target; at: number; from?: Provider; chain?: string[] };

const BROWSE = "__browse__"; // opção "Escolher outra pasta…" do seletor de projeto
const PROVIDER_LIST = Object.keys(PROVIDERS) as Provider[];
const EFFORTS: Record<Provider, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  antigravity: ["low", "medium", "high", "thinking"],
};
const EFFORT_NAME: Record<string, string> = { minimal: "Mínimo", low: "Baixo", medium: "Médio", high: "Alto", xhigh: "Muito alto", max: "Máximo", thinking: "Raciocínio" };

const modelName = (t: Target) =>
  t.provider === "claude" ? CLAUDE_MODELS.find((m) => m.id === t.model)?.name ?? (t.model || "Padrão")
  : t.provider === "antigravity" ? ANTIGRAVITY_MODELS.find((m) => m.id === t.model)?.name ?? (t.model || "Padrão")
  : t.model || "Modelo padrão";
const destName = (t: { provider: Provider; account?: string }) => (t.account ? `${PROVIDERS[t.provider]} (${t.account})` : PROVIDERS[t.provider]);
const targetLabel = (t: Target) => `${destName(t)} · ${modelName(t)} · ${EFFORT_NAME[t.effort] ?? t.effort}`;
const levelName = (l: Level) => LEVELS.find(([k]) => k === l)?.[1] ?? l;

// ---------- contexto ----------

export function RouterView({ sessions, notify, onChanged }: { sessions: Session[]; notify: (m: string) => void; onChanged: () => void }) {
  const [tab, setTab] = useState<"chat" | "config">("chat");
  const [cfg, setCfgState] = useState<RouterConfig>(() => withDefaults(read<Partial<RouterConfig> | null>("lume.router.config", null)));
  const setCfg = (c: RouterConfig) => (setCfgState(c), write("lume.router.config", c));
  const [history, setHistoryState] = useState<Routed[]>(() => read("lume.router.history", []));
  const setHistory = (h: Routed[]) => (setHistoryState(h), write("lume.router.history", h.slice(0, 40)));
  const [active, setActive] = useState<Routed | null>(null);
  const { data: usage } = useUsage();
  const claudeAccounts = useClaudeAccounts().map((a) => a.name ?? undefined);
  const agyAccounts = useAntigravityAccounts().map((a) => a.name ?? undefined);
  const accounts = { claude: claudeAccounts, antigravity: agyAccounts };
  const routeOf = (text: string, level?: Level, exclude: string[] = []) => route(text, cfg, usage, level, exclude, accounts);
  const projects = useMemo(() => [...new Set(sessions.map((s) => s.project))], [sessions]);

  const sessionOf = (r: Routed): Session => sessions.find((s) => sameSession(s, r)) ?? { provider: r.provider, id: r.id, project: r.project, title: r.title, updated: r.at };

  // histórico antigo guardava só o provider ("claude"); hoje é provider:conta
  const chainOf = (r: Routed) => (r.chain ?? [destKey(r.target)]).map((k) => (k.includes(":") ? k : `${k}:`));

  async function start(project: string, text: string, level: Level | undefined, exclude: string[] = [], request = text, from?: Provider) {
    const r = routeOf(request, level, exclude);
    if (!r.target) throw new Error(`Nenhum provider disponível para o nível ${levelName(r.level)}: ${r.skipped.map((s) => `${PROVIDERS[s.target.provider]} (${s.why})`).join(", ")}`);
    const t = r.target;
    const options = { model: t.model || undefined, effort: t.effort || undefined };
    const s = await api.newChat(t.provider, project, text, [], options, t.account);
    saveOpts(s, options); // a conversa abre com o modelo/esforço escolhidos pelo roteador
    const entry: Routed = { provider: s.provider, id: s.id, project, title: s.title, request, level: r.level, reason: r.reason, target: t, at: Date.now(), from, chain: [...exclude, destKey(t)] };
    setHistory([entry, ...history.filter((h) => !sameSession(h, entry))]);
    setActive(entry);
    onChanged();
    return entry;
  }

  async function handoff(h: Routed) {
    const t = await api.transcript(sessionOf(h), 80);
    const over = overCeiling(usage, h.target, cfg);
    const text = handoffText(PROVIDERS[h.provider], over ? `cota no teto (${over})` : "passagem manual", h.request, t.messages ?? [], cfg);
    const next = await start(h.project, text, h.level, chainOf(h), h.request, h.provider);
    notify(`Tarefa passada de ${destName(h.target)} para ${destName(next.target)}`);
  }

  return (
    <section className="recents router">
      <div className="drag-strip" data-drag />
      {!(tab === "chat" && active) && <header className="content-head" data-drag>
        <div>
          <h1>Roteador</h1>
          <p className="sub">Cada tarefa vai para o provider e modelo certos, conforme o nível e a cota de cada plano.</p>
        </div>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "on" : ""} onClick={() => setTab("chat")}>Tarefas</button>
          <button role="tab" aria-selected={tab === "config"} className={tab === "config" ? "on" : ""} onClick={() => setTab("config")}>Configurações</button>
        </div>
      </header>}
      {tab === "config" ? (
        <RouterSettings cfg={cfg} setCfg={setCfg} usage={usage} projects={projects} />
      ) : active ? (
        <ActiveTask key={`${active.provider}:${active.id}`} task={active} session={sessionOf(active)} cfg={cfg} usage={usage}
          next={routeOf(active.request, active.level, chainOf(active)).target}
          back={() => setActive(null)} handoff={() => handoff(active).catch((e) => notify(String(e)))} notify={notify} onChanged={onChanged}
          onMoved={(s) => {
            // conversa movida de conta: a tarefa passa a apontar para a conta nova
            const moved = { ...active, target: { ...active.target, account: s.account }, chain: [...chainOf(active), destKey({ provider: "claude", account: s.account })] };
            setActive(moved);
            setHistory(history.map((h) => (sameSession(h, moved) ? moved : h)));
            onChanged();
          }} />
      ) : (
        <NewTask cfg={cfg} usage={usage} projects={projects} history={history} sessions={sessions}
          start={(p, t, l) => start(p, t, l).then(() => undefined)} open={setActive} notify={notify} />
      )}
    </section>
  );
}

// ---------- nova tarefa ----------

/** Cada provider, e cada conta extra do Claude ou Antigravity como destino separado. */
function useDests() {
  const claudeAccounts = useClaudeAccounts();
  const agyAccounts = useAntigravityAccounts();
  return PROVIDER_LIST.flatMap((provider) => {
    const accs = provider === "claude" ? claudeAccounts : provider === "antigravity" ? agyAccounts : [];
    return accs.length > 1
      ? accs.map((a) => ({ provider, account: a.name ?? undefined }))
      : [{ provider, account: undefined as string | undefined }];
  });
}

function QuotaStrip({ usage, cfg }: { usage: UsageReport[] | null; cfg: RouterConfig }) {
  const dests = useDests();
  return (
    <div className="router-quotas">
      {dests.map((d) => {
        const p = d.provider;
        const q = quota(usage, d);
        const over = overCeiling(usage, d, cfg);
        return (
          <span key={destKey(d)} className={`router-quota ${!cfg.providers[p].enabled ? "off" : ""}`} title={over ?? `${destName(d)} · teto: ${cfg.providers[p].ceiling}% (5 h) · ${cfg.providers[p].weeklyCeiling}% (semanal)`}>
            <ProviderIcon p={p} />
            {d.account && <span className="account-tag">{d.account}</span>}
            {q.short != null ? <><Ring used={q.short} /><span className={`usage-pct ${heat(q.short)}`}>{Math.round(q.short)}%</span></> : <span className="dash-meta">sem leitura</span>}
            {over && <span className="router-flag">no teto</span>}
            {!cfg.providers[p].enabled && <span className="router-flag">desligado</span>}
          </span>
        );
      })}
    </div>
  );
}

function RouteCard({ text, cfg, usage, level }: { text: string; cfg: RouterConfig; usage: UsageReport[] | null; level?: Level }) {
  const claudeAccounts = useClaudeAccounts().map((a) => a.name ?? undefined);
  const agyAccounts = useAntigravityAccounts().map((a) => a.name ?? undefined);
  const r = route(text, cfg, usage, level, [], { claude: claudeAccounts, antigravity: agyAccounts });
  return (
    <div className="router-card">
      <div className="router-card-row">
        <span className={`router-level ${r.level}`}>{levelName(r.level)}</span>
        {r.target ? <span className="dash-row-head"><ProviderIcon p={r.target.provider} /> {targetLabel(r.target)}</span> : <span className="usage-error">Nenhum provider disponível</span>}
      </div>
      <span className="dash-meta">Por quê: {r.reason}</span>
      {r.skipped.map((s, i) => <span key={i} className="dash-meta">Pulou {destName(s.target)}: {s.why}</span>)}
    </div>
  );
}

function NewTask({ cfg, usage, projects, history, sessions, start, open, notify }: {
  cfg: RouterConfig; usage: UsageReport[] | null; projects: string[]; history: Routed[]; sessions: Session[];
  start: (project: string, text: string, level?: Level) => Promise<void>; open: (r: Routed) => void; notify: (m: string) => void;
}) {
  const [chosen, setProject] = useState(() => read<string>("lume.router.project", ""));
  const project = chosen || projects[0] || ""; // as sessões chegam depois do primeiro render
  const [extra, setExtra] = useState<string[]>([]); // pastas escolhidas agora (ainda sem sessão)
  const [text, setText] = useState("");
  const [level, setLevel] = useState<Level | undefined>();
  const [sending, setSending] = useState(false);
  const choose = (p: string) => (setProject(p), write("lume.router.project", p));

  const send = async () => {
    if (!text.trim() || !project || sending) return;
    setSending(true);
    try {
      await start(project, text, level);
      setText("");
      setLevel(undefined);
    } catch (e) {
      notify(String(e));
    } finally {
      setSending(false);
    }
  };
  const browse = async () => {
    const dir = await pickFolder({ directory: true, title: "Pasta do projeto" });
    if (typeof dir === "string") (setExtra((x) => [...new Set([dir, ...x])]), choose(dir));
  };

  return (
    <div className="sessions dash-body">
      <QuotaStrip usage={usage} cfg={cfg} />
      <div className="dash-card router-compose">
        <div className="router-compose-head">
          <select value={project} onChange={(e) => (e.target.value === BROWSE ? browse() : choose(e.target.value))} aria-label="Projeto">
            {!project && <option value="">Escolha o projeto…</option>}
            {[...new Set([...extra, ...projects])].map((p) => <option key={p} value={p}>{projectName(p)}</option>)}
            <option value={BROWSE}>Escolher outra pasta…</option>
          </select>
          <div className="segmented" role="radiogroup" aria-label="Nível">
            <button role="radio" aria-checked={!level} className={!level ? "on" : ""} onClick={() => setLevel(undefined)}>Automático</button>
            {LEVELS.map(([l, name]) => <button key={l} role="radio" aria-checked={level === l} className={level === l ? "on" : ""} onClick={() => setLevel(l)}>{name}</button>)}
          </div>
        </div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Descreva a tarefa…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || (!cfg.confirm && !e.shiftKey))) (e.preventDefault(), send());
          }} />
        {text.trim() && <RouteCard text={text} cfg={cfg} usage={usage} level={level} />}
        <div className="router-actions">
          <span className="dash-meta">{cfg.confirm ? "Ctrl+Enter envia" : "Enter envia · Shift+Enter quebra linha"}</span>
          <button className="btn primary" disabled={!text.trim() || !project || sending} onClick={send}>{sending ? "Enviando…" : "Enviar"}</button>
        </div>
      </div>

      <div className="dash-card">
        <h3>Tarefas roteadas</h3>
        {!history.length && <p className="hint small">As tarefas enviadas por aqui aparecem nesta lista, com o motivo de cada escolha.</p>}
        {history.map((h) => {
          const s = sessions.find((x) => sameSession(x, h));
          return (
            <button key={`${h.provider}:${h.id}`} className="dash-project" onClick={() => open(h)} title={h.request}>
              <ProviderIcon p={h.provider} />
              <span className="dash-pname">
                <span className="name">{s?.title ?? h.title}</span>
                <span className="dash-meta">{projectName(h.project)} · {levelName(h.level)} · {h.from ? `passada de ${PROVIDERS[h.from]}` : h.reason}</span>
              </span>
              <span className="dash-meta">{ago(s?.updated ?? h.at)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- tarefa aberta ----------

function ActiveTask({ task, session, cfg, usage, next, back, handoff, notify, onChanged, onMoved }: {
  task: Routed; session: Session; cfg: RouterConfig; usage: UsageReport[] | null; next: Target | null; back: () => void; onMoved: (s: Session) => void; handoff: () => void; notify: (m: string) => void; onChanged: () => void;
}) {
  const activity = useActivity();
  const over = overCeiling(usage, task.target, cfg);
  const working = activityOf(activity, session)?.state === "working";
  const done = useRef(false);
  // passagem automática: só com o agente parado, uma vez por tarefa
  useEffect(() => {
    if (cfg.handoff.auto && over && next && !working && !done.current) {
      done.current = true;
      handoff();
    }
  }, [cfg.handoff.auto, over, working]);

  return (
    <div className="router-active">
      <div className="router-bar" data-drag>
        <button className="btn small" onClick={back} title="Voltar para as tarefas">
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Tarefas
        </button>
        <span className={`router-level ${task.level}`}>{levelName(task.level)}</span>
        <span className="dash-row-head"><ProviderIcon p={task.target.provider} /> {targetLabel(task.target)}</span>
        <span className="dash-meta grow router-why" title={task.from ? `Passada de ${PROVIDERS[task.from]}` : `Por quê: ${task.reason}`}>{task.from ? `passada de ${PROVIDERS[task.from]}` : task.reason}</span>
        {over && <span className="router-flag" title={over}>Cota no teto</span>}
        <button className="btn small" onClick={handoff} disabled={working || !next}
          title={working ? "Espere o agente terminar o turno" : next ? `Abre a tarefa em ${targetLabel(next)}, com o resumo do que já foi feito` : "Todos os providers deste nível já pegaram a tarefa, estão desligados ou no teto da cota"}>
          {next ? <>Passar para {destName(next)} <ProviderIcon p={next.provider} /></> : "Sem próximo provider"}
        </button>
      </div>
      <Chat session={session} notify={notify} onCreated={() => {}} onChanged={onChanged} onSessionChange={onMoved} />
    </div>
  );
}

// ---------- configurações ----------

function Toggle({ on, set, label }: { on: boolean; set: (v: boolean) => void; label: string }) {
  return <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => set(!on)}><span /></button>;
}

function Num({ value, set, min = 0, max = 100, suffix }: { value: number; set: (v: number) => void; min?: number; max?: number; suffix?: string }) {
  return (
    <label className="router-num">
      <input type="number" min={min} max={max} value={value} onChange={(e) => set(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
      {suffix && <span className="dash-meta">{suffix}</span>}
    </label>
  );
}

function TargetRow({ t, set, remove, up, down, codexModels }: { t: Target; set: (t: Target) => void; remove: () => void; up?: () => void; down?: () => void; codexModels: Model[] }) {
  const claudeAccounts = useClaudeAccounts();
  const antigravityAccounts = useAntigravityAccounts();
  const accounts = t.provider === "claude" ? claudeAccounts : t.provider === "antigravity" ? antigravityAccounts : [];
  const models = t.provider === "claude" ? CLAUDE_MODELS.map((m) => ({ id: m.id, name: m.name })) : t.provider === "antigravity" ? ANTIGRAVITY_MODELS.map((m) => ({ id: m.id, name: m.name })) : null;
  return (
    <div className="router-target">
      <select value={t.provider} onChange={(e) => {
        const p = e.target.value as Provider;
        set({ provider: p, model: p === "claude" ? "sonnet" : p === "antigravity" ? "flash" : "", effort: "medium" });
      }} aria-label="Provider">
        {PROVIDER_LIST.map((p) => <option key={p} value={p}>{PROVIDERS[p]}</option>)}
      </select>
      {(t.provider === "claude" || t.provider === "antigravity") && accounts.length > 1 && (
        <select value={t.account ?? ""} onChange={(e) => set({ ...t, account: e.target.value || undefined })} aria-label="Conta">
          {accounts.map((a) => <option key={a.name ?? ""} value={a.name ?? ""}>{accountName(a.name)}</option>)}
        </select>
      )}
      {models ? (
        <select value={t.model} onChange={(e) => set({ ...t, model: e.target.value })} aria-label="Modelo">
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      ) : (
        <select value={t.model} onChange={(e) => set({ ...t, model: e.target.value })} aria-label="Modelo">
          <option value="">Modelo padrão</option>
          {codexModels.map((m) => <option key={m.model} value={m.model}>{m.displayName}</option>)}
          {t.model && !codexModels.some((m) => m.model === t.model) && <option value={t.model}>{t.model}</option>}
        </select>
      )}
      <select value={t.effort} onChange={(e) => set({ ...t, effort: e.target.value })} aria-label="Esforço">
        {EFFORTS[t.provider].map((x) => <option key={x} value={x}>{EFFORT_NAME[x]}</option>)}
      </select>
      <span className="grow" />
      <button className="icon-btn small" onClick={up} disabled={!up} aria-label="Subir na ordem" title="Subir na ordem"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 7.5 6 4.5l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      <button className="icon-btn small" onClick={down} disabled={!down} aria-label="Descer na ordem" title="Descer na ordem"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      <button className="icon-btn small danger" onClick={remove} aria-label="Remover" title="Remover"><svg width="12" height="12" viewBox="0 0 12 12"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>
    </div>
  );
}

const words = (s: string) => s.split(",").map((w) => w.trim()).filter(Boolean);

function RouterSettings({ cfg, setCfg, usage, projects }: { cfg: RouterConfig; setCfg: (c: RouterConfig) => void; usage: UsageReport[] | null; projects: string[] }) {
  const [codexModels, setCodexModels] = useState<Model[]>([]);
  const [probe, setProbe] = useState("");
  const [rev, setRev] = useState(0); // remonta os campos de texto ao restaurar os padrões
  useEffect(() => {
    if (projects[0]) api.catalog(projects[0]).then((r) => setCodexModels(r.models ?? [])).catch(() => {});
  }, [projects[0]]);

  const patch = (p: Partial<RouterConfig>) => setCfg({ ...cfg, ...p });
  const rules = (p: Partial<RouterConfig["rules"]>) => patch({ rules: { ...cfg.rules, ...p } });
  const prov = (p: Provider, v: Partial<RouterConfig["providers"][Provider]>) => patch({ providers: { ...cfg.providers, [p]: { ...cfg.providers[p], ...v } } });
  const level = (l: Level, list: Target[]) => patch({ levels: { ...cfg.levels, [l]: list } });
  const move = (list: Target[], i: number, d: number) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    return next;
  };

  return (
    <div className="sessions dash-body router-settings">
      <div className="dash-card">
        <h3>Testar uma mensagem</h3>
        <input className="router-input" value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="Escreva um pedido para ver para onde ele iria" />
        {probe.trim() && <RouteCard text={probe} cfg={cfg} usage={usage} />}
      </div>

      <div className="dash-card">
        <h3>Comportamento</h3>
        <div className="setting"><div className="setting-text"><b>Revezar contas</b><p className="sub">Se a conta escolhida estiver no teto, tenta o mesmo modelo nas outras contas configuradas antes de mudar de provider.</p></div><Toggle on={cfg.rotateAccounts} set={(v) => patch({ rotateAccounts: v })} label="Revezar contas" /></div>
        <div className="setting"><div className="setting-text"><b>Confirmar antes de enviar</b><p className="sub">Mostra a decisão e só envia com Ctrl+Enter ou no botão. Desligado, o Enter já envia.</p></div><Toggle on={cfg.confirm} set={(v) => patch({ confirm: v })} label="Confirmar antes de enviar" /></div>
      </div>

      <div className="dash-card">
        <h3>Providers e cotas</h3>
        <p className="sub">Acima do teto, o provider é pulado e a tarefa vai para o próximo da lista do nível.</p>
        {PROVIDER_LIST.map((p) => {
          const q = quota(usage, { provider: p });
          return (
            <div key={p} className="setting">
              <div className="setting-text">
                <b className="dash-row-head"><ProviderIcon p={p} /> {PROVIDERS[p]}</b>
                <p className="sub">Agora: {q.short != null ? `${Math.round(q.short)}% (5 h)` : "sem leitura"}{q.weekly != null ? ` · ${Math.round(q.weekly)}% (semanal)` : ""}</p>
              </div>
              <div className="router-fields">
                <span className="dash-meta">Teto 5 h</span><Num value={cfg.providers[p].ceiling} set={(v) => prov(p, { ceiling: v })} suffix="%" />
                <span className="dash-meta">Teto semanal</span><Num value={cfg.providers[p].weeklyCeiling} set={(v) => prov(p, { weeklyCeiling: v })} suffix="%" />
                <Toggle on={cfg.providers[p].enabled} set={(v) => prov(p, { enabled: v })} label={`Usar ${PROVIDERS[p]}`} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="dash-card">
        <h3>Níveis e ordem de preferência</h3>
        <p className="sub">Para cada nível, o roteador usa o primeiro da lista que estiver ligado e abaixo do teto.</p>
        {LEVELS.map(([l, name]) => (
          <div key={l} className="router-level-block">
            <div className="router-card-row"><span className={`router-level ${l}`}>{name}</span></div>
            {cfg.levels[l].map((t, i, list) => (
              <TargetRow key={i} t={t} codexModels={codexModels}
                set={(v) => level(l, list.map((x, j) => (j === i ? v : x)))}
                remove={() => level(l, list.filter((_, j) => j !== i))}
                up={i > 0 ? () => level(l, move(list, i, -1)) : undefined}
                down={i < list.length - 1 ? () => level(l, move(list, i, 1)) : undefined} />
            ))}
            {!cfg.levels[l].length && <p className="usage-error">Sem provider neste nível: essas tarefas não serão enviadas.</p>}
            <button className="btn small" onClick={() => level(l, [...cfg.levels[l], { provider: "claude", model: "sonnet", effort: "medium" }])}>
              <svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              Adicionar
            </button>
          </div>
        ))}
      </div>

      <div className="dash-card">
        <h3>Regras de classificação</h3>
        <p className="sub">Ordem: palavra pesada, muitos arquivos ou pedido longo → Pesado; pedido curto sem arquivo ou palavra leve → Leve; o resto → nível padrão.</p>
        <div className="setting"><div className="setting-text"><b>Leve até</b><p className="sub">Pedido curto e sem arquivo citado.</p></div><Num value={cfg.rules.leveMaxChars} max={2000} set={(v) => rules({ leveMaxChars: v })} suffix="caracteres" /></div>
        <div className="setting"><div className="setting-text"><b>Pesado a partir de</b><p className="sub">Pedido longo costuma ser tarefa grande.</p></div><Num value={cfg.rules.pesadoMinChars} max={20000} set={(v) => rules({ pesadoMinChars: v })} suffix="caracteres" /></div>
        <div className="setting"><div className="setting-text"><b>Pesado com</b><p className="sub">Quantidade de arquivos citados no pedido.</p></div><Num value={cfg.rules.pesadoMinFiles} min={1} max={50} set={(v) => rules({ pesadoMinFiles: v })} suffix="arquivos" /></div>
        <div className="setting"><div className="setting-text"><b>Nível padrão</b><p className="sub">Quando nenhuma regra decide.</p></div>
          <select value={cfg.rules.defaultLevel} onChange={(e) => rules({ defaultLevel: e.target.value as Level })}>{LEVELS.map(([l, n]) => <option key={l} value={l}>{n}</option>)}</select>
        </div>
        <div className="setting column"><div className="setting-text"><b>Palavras de tarefa leve</b><p className="sub">Separadas por vírgula.</p></div>
          <textarea key={`l${rev}`} rows={2} defaultValue={cfg.rules.leveWords.join(", ")} onBlur={(e) => rules({ leveWords: words(e.target.value) })} />
        </div>
        <div className="setting column"><div className="setting-text"><b>Palavras de tarefa pesada</b><p className="sub">Separadas por vírgula. Valem mais que as leves.</p></div>
          <textarea key={`p${rev}`} rows={2} defaultValue={cfg.rules.pesadoWords.join(", ")} onBlur={(e) => rules({ pesadoWords: words(e.target.value) })} />
        </div>
      </div>

      <div className="dash-card">
        <h3>Passagem de tarefa</h3>
        <p className="sub">Quando a cota do provider passa do teto, a tarefa continua no próximo da lista com um resumo do que já foi feito.</p>
        <div className="setting"><div className="setting-text"><b>Passar automaticamente</b><p className="sub">Só acontece com o agente parado, uma vez por tarefa. Desligado, aparece o botão "Passar para o próximo".</p></div><Toggle on={cfg.handoff.auto} set={(v) => patch({ handoff: { ...cfg.handoff, auto: v } })} label="Passar automaticamente" /></div>
        <div className="setting"><div className="setting-text"><b>Mensagens no resumo</b><p className="sub">Últimas mensagens da conversa levadas para o próximo agente.</p></div><Num value={cfg.handoff.messages} min={0} max={30} set={(v) => patch({ handoff: { ...cfg.handoff, messages: v } })} /></div>
        <div className="setting column"><div className="setting-text"><b>Instrução para o próximo agente</b></div>
          <textarea key={`n${rev}`} rows={2} defaultValue={cfg.handoff.note} onBlur={(e) => patch({ handoff: { ...cfg.handoff, note: e.target.value } })} />
        </div>
      </div>

      <div className="router-actions">
        <span className="dash-meta">Pesos iniciais baseados no LLM Benchmark v4 do akitaonrails.com (set/2026).</span>
        <button className="btn small" onClick={() => window.confirm("Restaurar todas as configurações do Roteador?") && (setCfg(structuredClone(DEFAULT_CONFIG)), setRev((r) => r + 1))}>Restaurar padrões</button>
      </div>
    </div>
  );
}
