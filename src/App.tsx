import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import "./App.css";

type UpdateInfo = { version: string; notes: string | null };
type UpdateState =
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

function useAutoUpdate() {
  const [state, setState] = useState<UpdateState>({ kind: "checking" });
  const started = useRef(false); // StrictMode roda o efeito 2x em dev

  async function run() {
    setState({ kind: "checking" });
    try {
      const update = await invoke<UpdateInfo | null>("check_update");
      if (!update) return setState({ kind: "current" });
      setState({ kind: "installing", version: update.version });
      await invoke("install_update"); // instala e reinicia o app
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, []);

  return { state, retry: run };
}

function UpdatePill({ state, retry }: ReturnType<typeof useAutoUpdate>) {
  const text = {
    checking: "Procurando atualizações…",
    current: "Atualizado",
    installing: state.kind === "installing" ? `Atualizando para ${state.version}…` : "",
    error: "Não deu para verificar atualizações",
  }[state.kind];
  return (
    <button
      className={`pill pill-${state.kind}`}
      onClick={state.kind === "error" || state.kind === "current" ? retry : undefined}
      title={state.kind === "error" ? state.message : "Verificar de novo"}
    >
      <span className="dot" />
      {text}
    </button>
  );
}

export default function App() {
  const [version, setVersion] = useState("");
  const update = useAutoUpdate();

  useEffect(() => {
    getVersion().then(setVersion);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Lume</div>
        <nav>
          <div className="section">Projetos</div>
          <div className="empty">As sessões entram aqui no próximo passo.</div>
        </nav>
        <footer>
          <UpdatePill {...update} />
          <div className="version">v{version}</div>
        </footer>
      </aside>
      <main className="content">
        <h1>Sessões</h1>
        <p className="muted">Claude Code, Codex e Antigravity, organizados por projeto.</p>
        <p className="muted">Esta versão chegou pela atualização automática.</p>
      </main>
    </div>
  );
}
