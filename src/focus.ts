import { useEffect, useState } from "react";

/** Modo Foco: perfis (ex.: Drakkar, G5) com os projetos que aparecem quando o perfil está ativo. */
export type FocusProfile = { id: string; name: string; projects: string[] };
export type Focus = { enabled: boolean; active: string | null; profiles: FocusProfile[] };

const KEY = "lume.focus";
const EMPTY: Focus = { enabled: false, active: null, profiles: [] };

function read(): Focus {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? "") };
  } catch {
    return EMPTY;
  }
}

export function useFocus() {
  const [focus, setFocus] = useState<Focus>(read);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(focus));
    } catch {}
  }, [focus]);

  const active = focus.enabled ? focus.profiles.find((p) => p.id === focus.active) ?? null : null;
  const allowed = active ? new Set(active.projects) : null; // null = sem filtro

  return {
    focus,
    active,
    visible: (project: string) => !allowed || allowed.has(project),
    /** Liga num perfil (ou desliga com null). */
    use: (id: string | null) => setFocus((f) => (id ? { ...f, enabled: true, active: id } : { ...f, enabled: false })),
    setEnabled: (enabled: boolean) =>
      setFocus((f) => ({ ...f, enabled, active: f.active ?? f.profiles[0]?.id ?? null })),
    addProfile: (name: string) => {
      const id = crypto.randomUUID();
      setFocus((f) => ({ ...f, active: f.active ?? id, profiles: [...f.profiles, { id, name, projects: [] }] }));
      return id;
    },
    updateProfile: (id: string, patch: Partial<FocusProfile>) =>
      setFocus((f) => ({ ...f, profiles: f.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) })),
    removeProfile: (id: string) =>
      setFocus((f) => {
        const profiles = f.profiles.filter((p) => p.id !== id);
        const active = f.active === id ? profiles[0]?.id ?? null : f.active;
        return { enabled: f.enabled && !!active, active, profiles };
      }),
  };
}

export type FocusApi = ReturnType<typeof useFocus>;
