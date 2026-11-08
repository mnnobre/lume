import { useEffect, useState } from "react";
import {
  Activity,
  Database,
  Monitor,
  Save,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
export type Preferences = {
  mode: "poll" | "events";
  interval_ms: number;
  pause_hidden: boolean;
  chart_samples: number;
};
export const defaults: Preferences = {
  mode: "poll",
  interval_ms: 2000,
  pause_hidden: true,
  chart_samples: 60,
};
export function loadPreferences(): Preferences {
  try {
    const v = JSON.parse(localStorage.getItem("nervo.preferences") || "null");
    if (
      v &&
      ["poll", "events"].includes(v.mode) &&
      Number.isInteger(v.interval_ms) &&
      v.interval_ms >= 100 &&
      v.interval_ms <= 60000 &&
      typeof v.pause_hidden === "boolean" &&
      Number.isInteger(v.chart_samples) &&
      v.chart_samples >= 20 &&
      v.chart_samples <= 300
    )
      return v;
  } catch {}
  return defaults;
}
type Backend = {
  collector_interval_ms: number;
  history_flush_ms: number;
  history_batch_kib: number;
  record_window_changes: boolean;
  record_clipboard_changes: boolean;
};
type Snapshot = { revision: number; values: Backend };
async function api(init?: RequestInit) {
  const r = await fetch("/api/settings", {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  let b;
  try {
    b = await r.json();
  } catch {
    throw new Error("Não foi possível acessar as configurações do backend.");
  }
  if (!r.ok) throw new Error(b.error || `Erro HTTP ${r.status}`);
  return b;
}
export default function Settings({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: (v: Preferences) => void;
}) {
  const [local, setLocal] = useState(preferences),
    [current, setCurrent] = useState<Snapshot>(),
    [values, setValues] = useState<Backend>(),
    [backendDefaults, setBackendDefaults] = useState<Backend>(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [localMessage, setLocalMessage] = useState("");
  async function load() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await api();
      setCurrent(r.current);
      setValues(r.current.values);
      setBackendDefaults(r.defaults);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load();
  }, []);
  function saveLocal(e: React.FormEvent) {
    e.preventDefault();
    if (!Number.isInteger(local.interval_ms) || local.interval_ms < 100 || local.interval_ms > 60000 || !Number.isInteger(local.chart_samples) || local.chart_samples < 20 || local.chart_samples > 300) {
      setLocalMessage("Informe um intervalo entre 100 e 60000 ms e entre 20 e 300 amostras. Se necessário, restaure os padrões.");
      return;
    }
    try {
      localStorage.setItem("nervo.preferences", JSON.stringify(local));
      onChange(local);
      setLocalMessage("Preferências salvas neste navegador.");
    } catch {
      setLocalMessage("O navegador não permitiu salvar as preferências.");
    }
  }
  async function saveBackend(e: React.FormEvent) {
    e.preventDefault();
    if (!current || !values) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const r = await api({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision: current.revision, values }),
      });
      setCurrent(r.current);
      setValues(r.current.values);
      setMessage("Configurações salvas no backend e aplicadas sem reiniciar.");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-page">
      <div className="info-strip">
        <SlidersHorizontal size={21} />
        <div>
          <b>Controle o ritmo do Nervo</b>
          <p>
            Painel, coleta do Windows e gravação em disco têm configurações
            independentes.
          </p>
        </div>
      </div>
      <div className="settings-grid">
        <form className="panel settings-card" onSubmit={saveLocal}>
          <div className="panel-heading">
            <h2>
              <Monitor size={18} /> Este painel
            </h2>
            <span className="tag">NESTE NAVEGADOR</span>
          </div>
          <div className="settings-body">
            <label htmlFor="display-mode">Modo de atualização</label>
            <select
              id="display-mode"
              value={local.mode}
              onChange={(e) =>
                setLocal({
                  ...local,
                  mode: e.target.value as Preferences["mode"],
                })
              }
            >
              <option value="poll">Por intervalo</option>
              <option value="events">Ao vivo por eventos (SSE)</option>
            </select>
            <p className="setting-help">
              Por eventos mantém uma conexão aberta e recebe novos contextos
              assim que o núcleo os publica. Reconecta automaticamente.
            </p>
            <label htmlFor="panel-interval">
              Intervalo do painel <span>ms</span>
            </label>
            <input
              id="panel-interval"
              type="number"
              min="100"
              max="60000"
              step="1"
              required
              disabled={local.mode === "events"}
              value={local.interval_ms}
              onChange={(e) =>
                setLocal({ ...local, interval_ms: e.target.valueAsNumber })
              }
            />
            <p className="setting-help">
              100 a 60.000 ms. Usado apenas no modo por intervalo; uma nova
              consulta começa depois da anterior terminar.
            </p>
            <label htmlFor="chart-samples">Amostras no gráfico</label>
            <input
              id="chart-samples"
              type="number"
              min="20"
              max="300"
              step="1"
              required
              value={local.chart_samples}
              onChange={(e) =>
                setLocal({ ...local, chart_samples: e.target.valueAsNumber })
              }
            />
            <label className="check-row">
              <input
                type="checkbox"
                checked={local.pause_hidden}
                onChange={(e) =>
                  setLocal({ ...local, pause_hidden: e.target.checked })
                }
              />
              <span>
                Pausar o painel quando a aba estiver oculta
                <small>A coleta e a memória do backend continuam.</small>
              </span>
            </label>
            <div className="settings-actions">
              <button className="primary" type="submit">
                <Save size={15} />
                Salvar preferências
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setLocal(defaults);
                  setLocalMessage("Padrões preparados. Salve para aplicar.");
                }}
              >
                Restaurar padrão
              </button>
            </div>
            {localMessage && (
              <p role="status" className="success setting-help">
                {localMessage}
              </p>
            )}
          </div>
        </form>
        <form className="panel settings-card" onSubmit={saveBackend}>
          <div className="panel-heading">
            <h2>
              <Activity size={18} /> Núcleo do Windows
            </h2>
            <span className="tag">TODOS OS CLIENTES</span>
          </div>
          <div className="settings-body">
            {error && (
              <div role="alert" className="error-banner">
                {error}
              </div>
            )}
            {values ? (
              <>
                <label htmlFor="collector-interval">
                  Intervalo de coleta <span>ms</span>
                </label>
                <input
                  id="collector-interval"
                  type="number"
                  min="50"
                  max="60000"
                  step="1"
                  required
                  value={values.collector_interval_ms}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      collector_interval_ms: e.target.valueAsNumber,
                    })
                  }
                />
                <div className="presets">
                  {[
                    { label: "Econômico", ms: 2000 },
                    { label: "Fluido", ms: 250 },
                    { label: "Rápido", ms: 50 },
                  ].map((p) => (
                    <button
                      type="button"
                      key={p.ms}
                      className={
                        values.collector_interval_ms === p.ms ? "selected" : ""
                      }
                      onClick={() =>
                        setValues({ ...values, collector_interval_ms: p.ms })
                      }
                    >
                      {p.label}
                      <small>{p.ms} ms</small>
                    </button>
                  ))}
                </div>
                <p className="setting-help">
                  Mouse, inatividade e clipboard são amostrados neste intervalo.
                  O evento de foco pode antecipar uma atualização. Não há
                  garantia de latência exata.
                </p>
                {values.collector_interval_ms < 250 && (
                  <div className="warning">
                    Com {values.collector_interval_ms} ms, a coleta pode ocorrer
                    até {Math.round(1000 / values.collector_interval_ms)} vezes
                    por segundo, além dos eventos de foco. Isso aumenta CPU,
                    tráfego local e renderizações do painel.
                  </div>
                )}
                <div className="settings-divider">
                  <Database size={16} /> Histórico em disco
                </div>
                <label htmlFor="flush-interval">
                  Intervalo de gravação <span>ms</span>
                </label>
                <input
                  id="flush-interval"
                  type="number"
                  min="1000"
                  max="300000"
                  step="1"
                  required
                  value={values.history_flush_ms}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      history_flush_ms: e.target.valueAsNumber,
                    })
                  }
                />
                <label htmlFor="batch-size">
                  Tamanho do lote <span>KiB</span>
                </label>
                <input
                  id="batch-size"
                  type="number"
                  min="64"
                  max="1024"
                  step="1"
                  required
                  value={values.history_batch_kib}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      history_batch_kib: e.target.valueAsNumber,
                    })
                  }
                />
                <p className="setting-help">
                  Grava ao atingir o tempo ou o tamanho. A checagem do escritor
                  ocorre a cada 250 ms; a fila mantém o limite de 4 MiB.
                </p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={values.record_window_changes}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        record_window_changes: e.target.checked,
                      })
                    }
                  />
                  <span>
                    Registrar mudanças de janela
                    <small>
                      Inclui o título. Desativar não apaga o histórico
                      existente.
                    </small>
                  </span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={values.record_clipboard_changes}
                    onChange={(e) =>
                      setValues({
                        ...values,
                        record_clipboard_changes: e.target.checked,
                      })
                    }
                  />
                  <span>
                    Registrar mudanças do clipboard
                    <small>
                      Somente metadados; o texto não é gravado automaticamente.
                    </small>
                  </span>
                </label>
                <div className="settings-actions">
                  <button className="primary" disabled={busy} type="submit">
                    <Save size={15} />
                    {busy ? "Salvando…" : "Aplicar no backend"}
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (backendDefaults) setValues(backendDefaults);
                      setMessage("Padrões preparados. Aplique para salvar.");
                    }}
                  >
                    Restaurar padrão
                  </button>
                </div>
              </>
            ) : (
              <p className="setting-help">
                {busy ? "Carregando configurações…" : "Backend indisponível."}
              </p>
            )}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={load}
            >
              <RefreshCw size={14} /> Recarregar configurações salvas
            </button>
            {message && (
              <p role="status" className="success setting-help">
                {message}
              </p>
            )}
          </div>
        </form>
      </div>
      <div className="scope-note">
        As preferências do painel ficam neste navegador. As configurações do
        núcleo ficam em settings.json junto ao token local e continuam valendo
        com o painel fechado. Intervalo menor não torna a IA mais rápida: afeta
        a atualização dos dados locais.
      </div>
    </div>
  );
}
