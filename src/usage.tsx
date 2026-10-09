import { useEffect, useRef, useState } from "react";
import { api, type Provider, type UsageReport } from "./api";

// cache único do uso (menu do rodapé e anel da caixa de mensagem): no máximo 1 leitura por minuto
let cache: { at: number; data: UsageReport[] } | null = null;
let inflight: Promise<UsageReport[]> | null = null;
const subs = new Set<(d: UsageReport[]) => void>();

function fetchUsage(force: boolean) {
  if (!force && cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.data);
  inflight ??= api
    .usage()
    .then((d) => {
      cache = { at: Date.now(), data: d };
      subs.forEach((f) => f(d));
      return d;
    })
    .finally(() => (inflight = null));
  return inflight;
}

export function useUsage() {
  const [data, setData] = useState<UsageReport[] | null>(cache?.data ?? null);
  const [loading, setLoading] = useState(false);
  const load = (force = false) => {
    setLoading(true);
    fetchUsage(force).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => {
    subs.add(setData);
    load();
    return () => void subs.delete(setData);
  }, []);
  return { data, loading, load };
}

export function untilText(ms: number | null) {
  if (!ms) return "";
  const min = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (min < 60) return `reinicia em ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `reinicia em ${h} h ${min % 60 ? `${min % 60} min` : ""}`.trim();
  return `reinicia em ${Math.round(h / 24)} d`;
}

export const heat = (used: number) => (used >= 90 ? "hot" : used >= 70 ? "warm" : "");

/** Anel com o % usado. */
export function Ring({ used }: { used: number }) {
  const r = 6.5, c = 2 * Math.PI * r;
  return (
    <svg className={`ring ${heat(used)}`} width="17" height="17" viewBox="0 0 17 17" aria-hidden>
      <circle cx="8.5" cy="8.5" r={r} className="ring-track" />
      <circle cx="8.5" cy="8.5" r={r} className="ring-fill" strokeDasharray={`${(Math.min(100, used) / 100) * c} ${c}`} />
    </svg>
  );
}

/** A janela que manda: 5 h do grupo principal (Sessão no Claude, 5 horas no Codex, Gemini no Antigravity). */
export const primaryWindow = (r: UsageReport) => r.windows.find((w) => !/seman/i.test(w.label)) ?? r.windows[0] ?? null;

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : `${(n / 1000).toFixed(1)}k`);

/** Anel de uso da conversa: clicando, abre contexto + limites do plano (como no Claude). */
export function UsageRing({ provider, context, onCompact }: { provider: Provider; context?: [number, number]; onCompact?: () => void }) {
  const { data, loading, load } = useUsage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    load();
    const out = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", out);
    return () => window.removeEventListener("mousedown", out);
  }, [open]);
  const report = data?.find((r) => r.provider === provider);
  const top = report && primaryWindow(report);
  const ctxPct = context ? (context[0] / context[1]) * 100 : null;
  // o anel mostra o que estiver mais perto do limite: contexto da conversa ou a janela de 5 h
  const ring = Math.max(ctxPct ?? 0, top?.used ?? 0);
  if (!top && ctxPct === null && !onCompact) return null;
  return (
    <div className="pop-wrap" ref={ref}>
      <button className={`composer-usage ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-label="Uso e contexto" title="Uso e contexto">
        <Ring used={ring} />
      </button>
      {open && (
        <div className="pop pop-up-right usage-pop">
          {!context && onCompact && <section><button className="up-btn" onClick={() => (setOpen(false), onCompact())}>Compactar sessão</button></section>}
          {context && ctxPct !== null && (
            <section>
              <div className="up-row"><span className="up-title">Janela de contexto</span><span className="up-muted">{tokens(context[0])} / {tokens(context[1])} ({Math.round(ctxPct)}%)</span></div>
              <div className="bar"><span className={heat(ctxPct)} style={{ width: `${Math.min(100, ctxPct)}%` }} /></div>
              <div className="up-row">
                <span className="up-muted">{tokens(Math.max(0, context[1] - context[0]))} livres</span>
                {onCompact && <button className="up-btn" onClick={() => (setOpen(false), onCompact())}>Compactar sessão</button>}
              </div>
            </section>
          )}
          {report && (
            <section>
              <div className="up-row"><span className="up-muted">Limites de uso do plano{report.plan ? ` · ${report.plan[0].toUpperCase()}${report.plan.slice(1)}` : ""}</span>{loading && <span className="up-muted">…</span>}</div>
              {report.error && <p className="up-muted">{report.error}</p>}
              {report.windows.map((w) => (
                <div key={w.label} className="up-limit">
                  <div className="up-row"><span>{w.label}</span><span className="up-muted">{untilText(w.resets_at)} <b className={heat(w.used)}>{Math.round(w.used)}%</b></span></div>
                  <div className="bar"><span className={heat(w.used)} style={{ width: `${Math.min(100, w.used)}%` }} /></div>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
