import { useEffect, useMemo, useState } from "react";
import { projectName } from "./api";
import type { FocusApi } from "./focus";

type Section = "focus";

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

export function Settings({ onClose, focus, projects }: { onClose: () => void; focus: FocusApi; projects: { path: string; count: number }[] }) {
  const [section, setSection] = useState<Section>("focus");
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
          <button className={`nav-item ${section === "focus" ? "active" : ""}`} onClick={() => setSection("focus")}>
            <svg width="14" height="14" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
            Modo Foco
          </button>
        </nav>
        <div className="settings-body">
          <button className="icon-btn settings-close" onClick={onClose} aria-label="Fechar">
            <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
          {section === "focus" && <FocusSettings f={focus} projects={projects} />}
        </div>
      </div>
    </div>
  );
}
