import { useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import type { ImageIn, Provider, Session } from "./api";

/** Popover simples: abre no clique, fecha ao clicar fora ou com Esc. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", out);
    window.addEventListener("keydown", esc);
    return () => (window.removeEventListener("mousedown", out), window.removeEventListener("keydown", esc));
  }, [open]);
  return { open, setOpen, ref };
}

// ---------- barra do git (acima da caixa) ----------

type GitInfo = { repo: string; branch: string; added: number; removed: number };

export function GitBar({ session, refreshKey, onAsk }: { session: Session; refreshKey: unknown; onAsk?: (prompt: string) => void }) {
  const [info, setInfo] = useState<GitInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const menu = usePopover();
  useEffect(() => {
    let alive = true;
    const load = () => invoke<GitInfo | null>("git_info", { project: session.project }).then((i) => alive && setInfo(i)).catch(() => {});
    load();
    const t = setInterval(load, 15_000);
    return () => ((alive = false), clearInterval(t));
  }, [session.project, refreshKey]);
  if (!info || hidden) return null;
  const pr = (draft: boolean) =>
    onAsk?.(`Crie um pull request${draft ? " em rascunho" : ""} com as mudanças da branch ${info.branch}: faça commit do que estiver pendente, dê push e abra o PR com um título e uma descrição claros.`);
  return (
    <div className="git-bar">
      <span className="git-where">{info.repo} <span>{info.branch}</span></span>
      <span className="grow" />
      {(info.added > 0 || info.removed > 0) && (
        <span className="git-diff"><span className="plus">+{info.added.toLocaleString("pt-BR")}</span> <span className="minus">−{info.removed.toLocaleString("pt-BR")}</span></span>
      )}
      {onAsk && (
        <div className="split" ref={menu.ref}>
          <button className="split-main" onClick={() => pr(false)}>Criar PR</button>
          <button className="split-arrow" aria-label="Mais opções de PR" onClick={() => menu.setOpen(!menu.open)}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 3.5L5 6.5l2.5-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
          {menu.open && (
            <div className="pop pop-up-right">
              <button className="pop-item" onClick={() => (menu.setOpen(false), pr(true))}>Criar PR em rascunho</button>
            </div>
          )}
        </div>
      )}
      <button className="git-close" aria-label="Ocultar" title="Ocultar" onClick={() => setHidden(true)}>×</button>
    </div>
  );
}

// ---------- "+" (arquivos, pasta, comandos) ----------

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const mention = (p: string) => (/\s/.test(p) ? `@"${p}"` : `@${p}`);

export type PlusMenuGroup = {id: string; label: string; loading?: boolean; error?: string; items: {id: string; label: string; detail?: string; disabled?: boolean; onSelect: () => void}[]};

export function PlusMenu({ onImages, onInsert, onSlash, notify, groups = [], onOpen }: {
  onImages: (imgs: { preview: string; image: ImageIn }[]) => void;
  onInsert: (text: string) => void;
  onSlash: () => void;
  notify?: (m: string) => void;
  groups?: PlusMenuGroup[];
  onOpen?: () => void;
}) {
  const pop = usePopover();
  const [submenu, setSubmenu] = useState<string | null>(null);
  const group = groups.find((g) => g.id === submenu);
  const addFiles = async () => {
    pop.setOpen(false);
    const picked = await pickFiles({ multiple: true, title: "Adicionar arquivos ou fotos" });
    const paths = picked ? (Array.isArray(picked) ? picked : [picked]) : [];
    const imgs = [];
    for (const p of paths.filter((p) => IMAGE.test(p))) {
      try {
        const image = await invoke<ImageIn>("read_image", { path: p });
        imgs.push({ preview: `data:${image.media_type};base64,${image.data}`, image });
      } catch (e) {
        notify?.(String(e));
      }
    }
    if (imgs.length) onImages(imgs);
    // os outros arquivos vão como menção (@caminho): o agente lê pelo próprio harness
    const others = paths.filter((p) => !IMAGE.test(p));
    if (others.length) onInsert(others.map(mention).join(" ") + " ");
  };
  const addFolder = async () => {
    pop.setOpen(false);
    const dir = await pickFiles({ directory: true, title: "Adicionar pasta" });
    if (typeof dir === "string") onInsert(mention(dir) + " ");
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.ctrlKey && e.key.toLowerCase() === "u" && (e.preventDefault(), void addFiles());
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="pop-wrap" ref={pop.ref}>
      <button className={`composer-icon-btn ${pop.open ? "on" : ""}`} aria-label="Adicionar" title="Adicionar" onClick={() => { setSubmenu(null); if (!pop.open) onOpen?.(); pop.setOpen(!pop.open); }}>
        <svg width="15" height="15" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </button>
      {pop.open && (
        <div className="pop pop-up-left">
          {group ? <>
            <button className="pop-item" onClick={() => setSubmenu(null)}>← {group.label}</button>
            {group.loading && <div className="pop-title" role="status">Carregando…</div>}
            {group.error && <div className="pop-title" role="status">{group.error}</div>}
            {!group.loading && !group.error && !group.items.length && <div className="pop-title">Nenhum item disponível</div>}
            <div className="integration-menu-items">
              {group.items.map((item) => <button key={item.id} className="pop-item mode" disabled={item.disabled} title={item.detail} onClick={() => { pop.setOpen(false); item.onSelect(); }}>
                <span className="grow"><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</span>
              </button>)}
            </div>
          </> : <>
          <button className="pop-item" onClick={addFiles}>
            <svg width="15" height="15" viewBox="0 0 16 16"><path d="M13.5 7.5l-5.6 5.6a3.3 3.3 0 0 1-4.7-4.7l5.8-5.8a2.2 2.2 0 0 1 3.1 3.1L6.3 11.5a1.1 1.1 0 0 1-1.6-1.6l5.2-5.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            <span className="grow">Adicionar arquivos ou fotos</span><kbd>Ctrl+U</kbd>
          </button>
          <button className="pop-item" onClick={addFolder}>
            <svg width="15" height="15" viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
            <span className="grow">Adicionar pasta</span>
          </button>
          <button className="pop-item" onClick={() => (pop.setOpen(false), onSlash())}>
            <svg width="15" height="15" viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M9.5 5l-3 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
            <span className="grow">Comandos de barra</span>
          </button>
          {groups.map((g) => <button key={g.id} className="pop-item" onClick={() => setSubmenu(g.id)}><span className="grow">{g.label}</span><span>›</span></button>)}
          </>}
        </div>
      )}
    </div>
  );
}

// ---------- modo de permissão ----------

export interface ModeItem {
  id: string;
  name: string;
  desc: string;
}

export const MODES: ModeItem[] = [
  { id: "auto", name: "Automático", desc: "A IA gerencia as decisões de permissão" },
  { id: "default", name: "Manual", desc: "Sempre perguntar antes de fazer alterações" },
  { id: "acceptEdits", name: "Aceitar edições", desc: "Aceitar todas as edições automaticamente" },
  { id: "plan", name: "Plano", desc: "Criar um plano antes de fazer alterações" },
  { id: "bypassPermissions", name: "Ignorar permissões", desc: "Aceita todas as permissões" },
];

export const ANTIGRAVITY_MODES: ModeItem[] = [
  { id: "auto", name: "Automático", desc: "A IA gerencia as decisões de permissão" },
  { id: "default", name: "Manual", desc: "Sempre perguntar antes de fazer alterações" },
  { id: "plan", name: "Plano", desc: "Criar um plano antes de executar mudanças" },
  { id: "bypassPermissions", name: "Ignorar permissões", desc: "Executa sem pedir confirmações" },
];

export function ModeSelector({
  provider,
  mode,
  modes: customModes,
  onChange,
  disabled,
}: {
  provider: Provider;
  mode?: string;
  modes?: ModeItem[];
  onChange: (m: string) => void;
  disabled?: boolean;
}) {
  const pop = usePopover();
  const modes = customModes ?? (provider === "antigravity" ? ANTIGRAVITY_MODES : MODES);
  useEffect(() => {
    if (!pop.open) return;
    const key = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= modes.length) (e.preventDefault(), onChange(modes[n - 1].id), pop.setOpen(false));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pop.open, modes]);

  const current = modes.find((m) => m.id === mode);
  return (
    <div className="pop-wrap" ref={pop.ref}>
      <button className={`mode-pill ${pop.open ? "on" : ""} ${mode === "bypassPermissions" ? "danger" : ""}`} disabled={disabled} onClick={() => pop.setOpen(!pop.open)}>
        {current?.name ?? (mode === "custom" ? "Personalizado" : "Permissões")}
        <svg width="9" height="9" viewBox="0 0 10 10"><path d="M2.5 3.5L5 6.5l2.5-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {pop.open && (
        <div className="pop pop-up-left modes">
          <div className="pop-title">Modo</div>
          {modes.map((m, i) => (
            <button key={m.id} className={`pop-item mode ${m.id === mode ? "selected" : ""}`} onClick={() => (onChange(m.id), pop.setOpen(false))}>
              <span className="grow">
                <b>{m.name}</b>
                <small>{m.desc}</small>
              </span>
              {m.id === mode && <span className="tick">✓</span>}
              <kbd>{i + 1}</kbd>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- esforço (o mesmo controle para Claude e Codex) ----------

const EFFORT_NAMES: Record<string, string> = {
  none: "Nenhum", minimal: "Mínimo", low: "Baixo", medium: "Médio", high: "Alto", xhigh: "Muito alto", max: "Máximo", ultra: "Ultra", thinking: "Thinking",
};
export const effortName = (e: string) => EFFORT_NAMES[e] ?? e;

export function EffortControl({ levels, value, recommended, onChange, disabled }: {
  levels: string[];
  value?: string;
  recommended?: string;
  onChange: (e: string | undefined) => void;
  disabled?: boolean;
}) {
  const pop = usePopover();
  if (!levels.length) return null;
  const current = value ?? recommended;
  const idx = Math.max(0, levels.indexOf(current ?? levels[Math.floor(levels.length / 2)]));
  const rec = recommended ? levels.indexOf(recommended) : -1;
  const frac = (i: number) => (levels.length === 1 ? 0.5 : i / (levels.length - 1));
  return (
    <div className="pop-wrap" ref={pop.ref}>
      <button className={`effort-pill-btn ${pop.open ? "on" : ""}`} disabled={disabled} onClick={() => pop.setOpen(!pop.open)} title="Esforço de raciocínio">
        {current ? effortName(current) : "Esforço"}
      </button>
      {pop.open && (
        <div className="pop pop-up-right effort-pop">
          <div className="effort-head">
            <span>Esforço</span> <b>{effortName(levels[idx])}</b>
            {value && (
              <button className="effort-reset" onClick={() => onChange(undefined)} title="Voltar ao padrão">Padrão</button>
            )}
          </div>
          <div className="effort-scale"><span>Mais rápido</span><span>Mais inteligente</span></div>
          <div className="effort-track">
            {levels.map((l, i) => <span key={l} className="effort-stop" style={{ "--x": frac(i) } as CSSProperties} />)}
            <input
              type="range"
              min={0}
              max={levels.length - 1}
              step={1}
              value={idx}
              aria-label="Esforço de raciocínio"
              aria-valuetext={effortName(levels[idx])}
              onChange={(e) => onChange(levels[Number(e.target.value)])}
            />
          </div>
          {rec >= 0 && <div className="effort-rec" style={{ "--x": frac(rec) } as CSSProperties}>Recomendado</div>}
        </div>
      )}
    </div>
  );
}

