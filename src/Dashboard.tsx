import { useEffect, useMemo, useState } from "react";
import { api, ago, PROVIDERS, projectName, sameSession, type Session, type WorkSession } from "./api";
import { ProviderIcon } from "./ProviderIcon";

const DAY = 86400_000;
type Period = "today" | "7d" | "30d" | "month";
const PERIODS: [Period, string][] = [["today", "Hoje"], ["7d", "7 dias"], ["30d", "30 dias"], ["month", "Este mês"]];

function startOf(p: Period) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (p === "7d") d.setDate(d.getDate() - 6);
  if (p === "30d") d.setDate(d.getDate() - 29);
  if (p === "month") d.setDate(1);
  return d.getTime();
}

/** Junta blocos sobrepostos (conversas em paralelo no mesmo projeto não contam em dobro), recortados em [from, to]. */
function merge(spans: [number, number][], from: number, to: number) {
  const out: [number, number][] = [];
  for (const [a, b] of spans.map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const total = (spans: [number, number][]) => spans.reduce((n, [a, b]) => n + b - a, 0);

export function duration(ms: number) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}
const day = (t: number) => new Date(t).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const hour = (t: number) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayKey = (t: number) => new Date(t).toDateString();

/** Tempo por dia (meia-noite local corta os blocos). */
function perDay(spans: [number, number][]) {
  const m = new Map<string, number>();
  for (let [a, b] of spans)
    while (a < b) {
      const d = new Date(a);
      d.setHours(24, 0, 0, 0);
      const end = Math.min(b, d.getTime());
      m.set(dayKey(a), (m.get(dayKey(a)) ?? 0) + end - a);
      a = end;
    }
  return m;
}

type ProjectWork = { path: string; spans: [number, number][]; ms: number; last: number; sessions: (WorkSession & { ms: number; last: number })[]; prompts: [number, string, WorkSession][]; files: string[] };

function report(p: ProjectWork, from: number, to: number) {
  const days = perDay(p.spans);
  const rel = (f: string) => (f.toLowerCase().startsWith(p.path.toLowerCase()) ? f.slice(p.path.length).replace(/^[\\/]/, "") : f);
  return [
    `${projectName(p.path)} (${day(from)} a ${day(to)})`,
    `Tempo trabalhado: ${duration(p.ms)} em ${days.size} ${days.size === 1 ? "dia" : "dias"}`,
    "",
    "Por dia:",
    ...[...days].map(([k, ms]) => `- ${day(new Date(k).getTime())}: ${duration(ms)}`),
    "",
    "Atividades:",
    ...p.sessions.map((s) => `- ${s.title} (${duration(s.ms)})`),
    ...(p.prompts.length ? ["", "Pedidos feitos:", ...p.prompts.map(([t, text]) => `- ${day(t)} ${hour(t)}: ${text.replace(/\s+/g, " ")}`)] : []),
    ...(p.files.length ? ["", `Arquivos alterados (${p.files.length}):`, ...p.files.map((f) => `- ${rel(f)}`)] : []),
  ].join("\n");
}

/** Para o cliente: tempo por projeto, o que foi feito e quando, tirado dos horários das conversas. */
export function Dashboard({ sessions, open, notify }: { sessions: Session[]; open: (s: Session) => void; notify: (m: string) => void }) {
  const [period, setPeriod] = useState<Period>("7d");
  const [log, setLog] = useState<WorkSession[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const from = startOf(period);
  const now = Date.now();

  useEffect(() => {
    let alive = true;
    setLog(null);
    api.workLog(from).then((l) => alive && setLog(l)).catch((e) => notify(String(e)));
    return () => void (alive = false);
  }, [period, sessions.length > 0]);

  const projects = useMemo<ProjectWork[]>(() => {
    const m = new Map<string, WorkSession[]>();
    for (const s of log ?? []) m.set(s.project, [...(m.get(s.project) ?? []), s]);
    return [...m].map(([path, list]) => {
      const spans = merge(list.flatMap((s) => s.spans), from, now);
      const sess = list
        .map((s) => { const own = merge(s.spans, from, now); return { ...s, ms: total(own), last: own[own.length - 1]?.[1] ?? 0 }; })
        .filter((s) => s.ms > 0)
        .sort((a, b) => b.last - a.last);
      return {
        path, spans, ms: total(spans), last: spans[spans.length - 1]?.[1] ?? 0, sessions: sess,
        prompts: list.flatMap((s) => s.prompts.map(([t, p]) => [t, p, s] as [number, string, WorkSession])).sort((a, b) => b[0] - a[0]),
        files: [...new Set(list.flatMap((s) => s.files))],
      };
    }).filter((p) => p.ms > 0).sort((a, b) => b.last - a.last);
  }, [log]);

  const all = merge(projects.flatMap((p) => p.spans), from, now);
  const days = perDay(projects.flatMap((p) => p.spans)); // soma por projeto (paralelo em projetos diferentes conta nos dois)
  const sum = projects.reduce((n, p) => n + p.ms, 0);
  const longest = Math.max(1, ...projects.map((p) => p.ms));
  const cur = projects.find((p) => p.path === selected) ?? projects[0] ?? null; // começa pelo mais recente
  const openWork = (w: WorkSession) => { const s = sessions.find((x) => sameSession(x, w)); if (s) open(s); };
  const copy = (p: ProjectWork) =>
    navigator.clipboard.writeText(report(p, from, now)).then(() => notify(`Relatório de ${projectName(p.path)} copiado`), (e) => notify(String(e)));

  // barras por dia do período
  const bars: [number, number][] = [];
  for (let t = from; t < now; t += DAY) { const d = new Date(t); bars.push([t, days.get(d.toDateString()) ?? 0]); }
  const tallest = Math.max(1, ...bars.map((b) => b[1]));

  return (
    <section className="recents dashboard">
      <div className="drag-strip" data-drag />
      <header className="content-head" data-drag>
        <div>
          <h1>Dashboard</h1>
          <p className="sub">Tempo e atividades por projeto. Pausas de mais de 15 min não contam.</p>
        </div>
        <div className="filters">
          {PERIODS.map(([p, label]) => (
            <button key={p} className={`chip ${period === p ? "on" : ""}`} onClick={() => setPeriod(p)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="sessions dash-body">
        {!log && <p className="hint">Lendo as conversas…</p>}
        {log && (
          <>
            <div className="dash-tiles">
              <div className="dash-tile"><span className="dash-num">{duration(sum)}</span><span className="dash-label">Tempo nos projetos</span></div>
              <div className="dash-tile"><span className="dash-num">{projects.length}</span><span className="dash-label">Projetos trabalhados</span></div>
              <div className="dash-tile"><span className="dash-num">{days.size}</span><span className="dash-label">Dias com trabalho</span></div>
              <div className="dash-tile"><span className="dash-num">{duration(total(all) / Math.max(1, days.size))}</span><span className="dash-label">Média por dia</span></div>
            </div>

            {bars.length > 1 && (
              <div className="dash-card">
                <h3>Tempo por dia</h3>
                <div className="dash-bars" role="img" aria-label="Tempo trabalhado por dia">
                  {bars.map(([t, ms]) => (
                    <div key={t} className="dash-bar-col" title={`${day(t)}: ${ms ? duration(ms) : "sem trabalho"}`}>
                      <div className="dash-bar-track"><span style={{ height: `${(ms / tallest) * 100}%` }} /></div>
                      <span className="dash-bar-label">{bars.length <= 10 || new Date(t).getDay() === 1 ? day(t) : ""}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="dash-grid wide">
              <div className="dash-card">
                <h3>Projetos</h3>
                {!projects.length && <p className="hint small">Nenhuma atividade no período.</p>}
                {projects.map((p) => (
                  <button key={p.path} className={`dash-project ${cur === p ? "active" : ""}`} onClick={() => setSelected(p.path)} title={p.path}>
                    <span className="dash-pname">
                      <span className="name">{projectName(p.path)}</span>
                      <span className="dash-meta">{p.sessions.length} {p.sessions.length === 1 ? "conversa" : "conversas"} · {ago(p.last)}</span>
                    </span>
                    <span className="dash-pbar"><span style={{ width: `${(p.ms / longest) * 100}%` }} /></span>
                    <span className="dash-time">{duration(p.ms)}</span>
                  </button>
                ))}
              </div>

              <div className="dash-card">
                {!cur ? (
                  <p className="hint small">Escolha um projeto para ver o que foi feito e copiar o relatório.</p>
                ) : (
                  <>
                    <div className="dash-detail-head">
                      <div>
                        <h3>{projectName(cur.path)}</h3>
                        <span className="dash-meta">{duration(cur.ms)} em {perDay(cur.spans).size} dia(s) · {cur.files.length} arquivo(s) alterado(s)</span>
                      </div>
                      <button className="chip on" onClick={() => copy(cur)}>Copiar relatório</button>
                    </div>
                    <h3 className="dash-gap">Conversas</h3>
                    {cur.sessions.map((s) => (
                      <button key={`${s.provider}:${s.id}`} className="dash-project" onClick={() => openWork(s)} title="Abrir conversa">
                        <ProviderIcon p={s.provider} />
                        <span className="name">{s.title}</span>
                        <span className="dash-meta">{day(s.last)} · {duration(s.ms)}</span>
                      </button>
                    ))}
                    {cur.prompts.length > 0 && <h3 className="dash-gap">Pedidos feitos</h3>}
                    <ul className="dash-prompts">
                      {cur.prompts.slice(0, 60).map(([t, text, s], i) => (
                        <li key={i} title={PROVIDERS[s.provider]}>
                          <span className="dash-meta">{day(t)} {hour(t)}</span>
                          <span>{text}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
