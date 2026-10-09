import { useEffect, useState } from "react";
import { api, type Harness } from "./api";

const SEEN = "lume.harnessSeen"; // última versão vista de cada harness, para avisar quando muda
const EVERY = 6 * 60 * 60 * 1000; // confere de novo a cada 6 h

const readSeen = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN) ?? "{}");
  } catch {
    return {};
  }
};

/** Versões dos harness + aviso "X atualizou de A para B" quando o app/CLI muda de versão. */
export function useHarness(notify: (m: string) => void) {
  const [list, setList] = useState<Harness[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    api
      .harness()
      .then((l) => {
        const seen = readSeen();
        const changed = l.filter((h) => h.installed && seen[h.id] && seen[h.id] !== h.installed);
        if (changed.length) notify(changed.map((h) => `${h.name} atualizou: ${seen[h.id]} → ${h.installed}`).join(" · "));
        const next = { ...seen };
        for (const h of l) if (h.installed) next[h.id] = h.installed;
        try {
          localStorage.setItem(SEEN, JSON.stringify(next));
        } catch {}
        setList(l);
      })
      .catch((e) => notify(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, EVERY);
    return () => clearInterval(t);
  }, []);

  return { list, loading, refresh, outdated: (list ?? []).filter((h) => h.outdated).length };
}

export type HarnessApi = ReturnType<typeof useHarness>;
