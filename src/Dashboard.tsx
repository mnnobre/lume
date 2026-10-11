import { useMemo } from "react";
import { ago, PROVIDERS, projectName, type Provider, type Session } from "./api";
import { activityOf, useActivity } from "./liveStatus";
import { ProviderIcon } from "./ProviderIcon";
import { heat, untilText, useUsage } from "./usage";

const WEEK = 7 * 86400_000;

/** Visão geral: números das conversas, IAs trabalhando agora e uso dos planos. */
export function Dashboard({ sessions, open }: { sessions: Session[]; open: (s: Session) => void }) {
  const activity = useActivity();
  const { data: usage } = useUsage();
  const since = Date.now() - WEEK;
  const working = sessions.filter((s) => activityOf(activity, s)?.state === "working");
  const week = sessions.filter((s) => s.updated >= since);

  const byProvider = (Object.keys(PROVIDERS) as Provider[]).map((p) => ({ p, n: sessions.filter((s) => s.provider === p).length }));
  const most = Math.max(1, ...byProvider.map((x) => x.n));

  // projetos com mais conversas mexidas na semana; clicar abre a mais recente
  const top = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of week) m.set(s.project, [...(m.get(s.project) ?? []), s]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  }, [sessions]);

  const tiles: [string, number][] = [
    ["Conversas", sessions.length],
    ["Projetos", new Set(sessions.map((s) => s.project)).size],
    ["Nos últimos 7 dias", week.length],
    ["Trabalhando agora", working.length],
  ];

  return (
    <section className="recents dashboard">
      <div className="drag-strip" data-drag />
      <header className="content-head" data-drag>
        <div>
          <h1>Dashboard</h1>
          <p className="sub">Visão geral das suas IAs.</p>
        </div>
      </header>
      <div className="sessions dash-body">
        <div className="dash-tiles">
          {tiles.map(([label, n]) => (
            <div key={label} className="dash-tile">
              <span className="dash-num">{n}</span>
              <span className="dash-label">{label}</span>
            </div>
          ))}
        </div>

        <div className="dash-grid">
          <div className="dash-card">
            <h3>Uso das IAs</h3>
            {!usage && <p className="hint small">Carregando…</p>}
            {usage?.map((r) => (
              <div key={r.provider} className="dash-usage">
                <div className="dash-row-head"><ProviderIcon p={r.provider} /> {PROVIDERS[r.provider]}{r.plan && <span className="plan">{r.plan}</span>}</div>
                {r.error && !r.windows.length && <p className="usage-error">{r.error}</p>}
                {r.windows.map((w) => (
                  <div key={w.label} className="usage-row">
                    <div className="usage-label"><span>{w.label}</span><span className={`usage-pct ${heat(w.used)}`}>{Math.round(w.used)}%</span></div>
                    <div className="bar"><span className={heat(w.used)} style={{ width: `${Math.min(100, w.used)}%` }} /></div>
                    <div className="usage-reset">{untilText(w.resets_at)}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="dash-card">
            <h3>Conversas por IA</h3>
            {byProvider.map(({ p, n }) => (
              <div key={p} className="usage-row" title={`${n} conversas`}>
                <div className="usage-label"><span className="dash-row-head"><ProviderIcon p={p} /> {PROVIDERS[p]}</span><span>{n}</span></div>
                <div className="bar"><span style={{ width: `${(n / most) * 100}%` }} /></div>
              </div>
            ))}

            <h3 className="dash-gap">Projetos mais ativos na semana</h3>
            {!top.length && <p className="hint small">Nenhuma conversa nos últimos 7 dias.</p>}
            {top.map(([path, list]) => (
              <button key={path} className="dash-project" onClick={() => open(list[0])} title={path}>
                <span className="name">{projectName(path)}</span>
                <span className="dash-meta">{list.length} {list.length === 1 ? "conversa" : "conversas"} · {ago(list[0].updated)}</span>
              </button>
            ))}

            {working.length > 0 && <h3 className="dash-gap">Trabalhando agora</h3>}
            {working.map((s) => (
              <button key={`${s.provider}:${s.id}`} className="dash-project" onClick={() => open(s)} title={s.title}>
                <span className="spinner small" />
                <span className="name">{s.title}</span>
                <span className="dash-meta">{projectName(s.project)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
