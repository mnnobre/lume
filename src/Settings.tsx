import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, projectName } from "./api";
import type { FocusApi } from "./focus";
import type { HarnessApi } from "./harness";

export type Section = "focus" | "harness" | "notifications";

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function FocusSettings({ f, projects }: { f: FocusApi; projects: { path: string; count: number }[] }) {
  const { focus } = f;
  const [editing, setEditing] = useState<string | null>(focus.active ?? focus.profiles[0]?.id ?? null);
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const profile = focus.profiles.find((p) => p.id === editing) ?? null;

  useEffect(() => {
    if (!profile && focus.profiles.length) setEditing(focus.profiles[0].id);
  }, [focus.profiles.length]);

  const shown = useMemo(() => {
    const q = filter.toLowerCase();
    return projects.filter((p) => !q || p.path.toLowerCase().includes(q));
  }, [projects, filter]);

  const selected = new Set(profile?.projects ?? []);
  const setProjects = (paths: string[]) => profile && f.updateProfile(profile.id, { projects: paths });
  const toggleProject = (path: string) =>
    setProjects(selected.has(path) ? [...selected].filter((p) => p !== path) : [...selected, path]);

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    setEditing(f.addProfile(name));
    setNewName("");
  };

  return (
    <>
      <h3>Modo Foco</h3>
      <div className="setting">
        <div className="setting-text">
          <b>Ativar Modo Foco</b>
          <p>Mostra apenas os projetos do perfil ativo na barra lateral e em Recentes. Dá para trocar de perfil rápido pelo menu no canto inferior esquerdo.</p>
        </div>
        <Toggle on={focus.enabled} onChange={f.setEnabled} label="Ativar Modo Foco" />
      </div>

      <div className="setting column">
        <div className="setting-text">
          <b>Perfis</b>
          <p>Um perfil para cada contexto: por exemplo, Drakkar, G5 ou Pessoal.</p>
        </div>
        <div className="profiles">
          {focus.profiles.map((p) => (
            <button key={p.id} className={`profile-chip ${editing === p.id ? "selected" : ""}`} onClick={() => setEditing(p.id)}>
              {focus.enabled && focus.active === p.id && <span className="dot on" />}
              {p.name}
              <span className="count">{p.projects.length}</span>
            </button>
          ))}
          <form
            className="new-profile"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Novo perfil…" />
            <button className="btn small" disabled={!newName.trim()}>Criar</button>
          </form>
        </div>
      </div>

      {profile && (
        <div className="setting column">
          <div className="profile-head">
            <input
              className="profile-name"
              value={profile.name}
              onChange={(e) => f.updateProfile(profile.id, { name: e.target.value })}
              aria-label="Nome do perfil"
            />
            <button className="btn small" onClick={() => f.use(profile.id)} disabled={focus.enabled && focus.active === profile.id}>
              {focus.enabled && focus.active === profile.id ? "Em uso" : "Usar agora"}
            </button>
            <button className="btn small danger" onClick={() => f.removeProfile(profile.id)}>Excluir</button>
          </div>

          <div className="picker">
            <div className="picker-bar">
              <div className="search">
                <svg width="13" height="13" viewBox="0 0 16 16"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar projetos (ex.: Drakkar)" />
              </div>
              <span className="picker-count">{selected.size} de {projects.length}</span>
              <button className="btn small" onClick={() => setProjects([...new Set([...selected, ...shown.map((p) => p.path)])])}>Marcar visíveis</button>
              <button className="btn small" onClick={() => setProjects([...selected].filter((p) => !shown.some((s) => s.path === p)))}>Desmarcar visíveis</button>
            </div>
            <div className="picker-list">
              {shown.map((p) => (
                <label key={p.path} className="pick" title={p.path}>
                  <input type="checkbox" checked={selected.has(p.path)} onChange={() => toggleProject(p.path)} />
                  <span className="pick-name">{projectName(p.path)}</span>
                  <span className="pick-path">{p.path}</span>
                  <span className="count">{p.count}</span>
                </label>
              ))}
              {!shown.length && <p className="hint">Nenhum projeto encontrado.</p>}
            </div>
          </div>
        </div>
      )}
      {!focus.profiles.length && <p className="hint">Crie um perfil para escolher os projetos dele.</p>}
    </>
  );
}

function HarnessSettings({ h, notify }: { h: HarnessApi; notify: (m: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const update = (id: string) => {
    setBusy(id);
    api
      .updateHarness(id)
      .then((msg) => {
        notify(msg);
        h.refresh();
      })
      .catch((e) => notify(String(e)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <h3>Harness</h3>
      <p className="settings-intro">
        O Lume não tem harness próprio: usa o Claude Code, o Codex e o Antigravity instalados. Os apps se atualizam sozinhos e o Lume avisa quando
        a versão muda; as CLIs, que podem ficar para trás sem você notar, são comparadas com a versão mais nova publicada.
      </p>
      <div className="harness-list">
        {!h.list && <p className="hint">Conferindo versões…</p>}
        {h.list?.map((x) => (
          <div key={x.id} className="harness">
            <div className="setting-text">
              <b>{x.name}</b>
              <p>
                {x.installed ? `Instalado ${x.installed}` : "Não encontrado"}
                {x.detail ? ` · ${x.detail}` : ""}
              </p>
            </div>
            {x.outdated ? (
              <span className="badge-update">{x.latest} disponível</span>
            ) : x.installed ? (
              <span className="badge-ok">{x.auto ? (x.latest ? `em dia (${x.latest})` : "atualiza sozinho") : "em dia"}</span>
            ) : null}
            {x.can_update && x.outdated && (
              <button className="btn small primary" disabled={busy === x.id} onClick={() => update(x.id)}>
                {busy === x.id ? "Atualizando…" : "Atualizar"}
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="btn small" onClick={h.refresh} disabled={h.loading}>{h.loading ? "Conferindo…" : "Verificar agora"}</button>
    </>
  );
}

function NotificationSettings({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <>
      <h3>Notificações</h3>
      <div className="setting">
        <div className="setting-text">
          <b>Avisar quando a IA terminar ou pedir aprovação</b>
          <p>Notificação do Windows para conversas enviadas pelo Lume, só quando o Lume não está em primeiro plano.</p>
        </div>
        <Toggle on={on} onChange={set} label="Notificações" />
      </div>
    </>
  );
}

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "focus", label: "Modo Foco", icon: <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg> },
  { id: "harness", label: "Harness", icon: <svg width="14" height="14" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M5 7l2 1.5L5 10M8.5 10h2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg> },
  { id: "notifications", label: "Notificações", icon: <svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14a1.6 1.6 0 0 0 3 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg> },
];

export function Settings({ onClose, focus, projects, harness, notifications, initial = "focus", notify }: {
  onClose: () => void;
  focus: FocusApi;
  projects: { path: string; count: number }[];
  harness: HarnessApi;
  notifications: { on: boolean; set: (v: boolean) => void };
  initial?: Section;
  notify: (m: string) => void;
}) {
  const [section, setSection] = useState<Section>(initial);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <div className="section">Configurações</div>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${section === n.id ? "active" : ""}`} onClick={() => setSection(n.id)}>
              {n.icon}
              {n.label}
              {n.id === "harness" && harness.outdated > 0 && <span className="nav-badge">{harness.outdated}</span>}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={onClose} aria-label="Fechar">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          {section === "focus" && <FocusSettings f={focus} projects={projects} />}
          {section === "harness" && <HarnessSettings h={harness} notify={notify} />}
          {section === "notifications" && <NotificationSettings {...notifications} />}
        </div>
      </div>
    </div>
  );
}
