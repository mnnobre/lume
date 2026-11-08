import Settings, { loadPreferences } from "./Settings";
import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  Copy,
  Cpu,
  Database,
  FileText,
  Folder,
  HardDrive,
  Layers,
  Monitor,
  MousePointer2,
  Play,
  Plug,
  Radio,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Terminal,
  Workflow,
  X,
} from "lucide-react";
type Obj = Record<string, any>;
type Tool = {
  name: string;
  title: string;
  description: string;
  group: string;
  mutation: boolean;
  inputSchema: Obj;
};
async function request(path: string, init?: RequestInit) {
  const r = await fetch(`/api/${path}`, {
    ...init,
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok)
    throw new Error(
      `Backend indisponível (HTTP ${r.status}). Verifique se o Nervo está iniciado.`,
    );
  return r.json();
}
async function call(name: string, args: Obj = {}) {
  return request(`tools/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arguments: args, actor: "diagnostic-console" }),
  });
}
const bytes = (n?: number) =>
  n === undefined
    ? "—"
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} KiB`
        : `${(n / 1024 / 1024).toFixed(1)} MiB`;
const time = (n?: number) =>
  n === undefined
    ? "—"
    : `${Math.floor(n / 3600)
        .toString()
        .padStart(2, "0")}:${Math.floor((n % 3600) / 60)
        .toString()
        .padStart(2, "0")}:${Math.floor(n % 60)
        .toString()
        .padStart(2, "0")}`;
const clock = (v: string) => new Date(v).toLocaleTimeString("pt-BR");
const examples: Record<string, Obj> = {
  files_read: { path: "exemplo.md" },
  files_write: { path: "exemplo.md", content: "# Olá, Nervo\n" },
  files_create_directory: { path: "notas" },
  files_list: { path: "" },
  memory_list: { path: "" },
  memory_read: { path: "INDEX.md" },
  clipboard_get: { include_text: false },
  windows_list: { limit: 50 },
  processes_list: { limit: 50 },
  events_read: { after: 0, limit: 50 },
};
export default function App() {
  const [preferences, setPreferences] = useState(loadPreferences);
  const [transport, setTransport] = useState("connecting");
  const [tab, setTab] = useState("Visão geral"),
    [health, setHealth] = useState<Obj>(),
    [context, setContext] = useState<Obj>(),
    [system, setSystem] = useState<Obj>(),
    [tools, setTools] = useState<Tool[]>([]),
    [events, setEvents] = useState<Obj[]>([]),
    [error, setError] = useState(""),
    [updated, setUpdated] = useState(""),
    [samples, setSamples] = useState<number[]>([]),
    [selected, setSelected] = useState<Tool>(),
    [query, setQuery] = useState(""),
    [copied, setCopied] = useState(false),
    [gap, setGap] = useState(false);
  const session = useRef(""),
    cursor = useRef(0);
  useEffect(() => {
    let disposed = false,
      generation = 0,
      timer: ReturnType<typeof setTimeout>,
      source: EventSource | undefined;
    function consume(h: Obj, c: Obj, e: Obj) {
      const changed = session.current !== h.session_id;
      if (changed) {
        session.current = h.session_id;
        cursor.current = 0;
        setGap(false);
        setSamples([]);
      }
      cursor.current = e.next_cursor;
      setGap((v) => (changed ? false : v) || e.gap);
      setEvents((v) => [...(changed ? [] : v), ...e.items].slice(-100));
      setHealth(h);
      setContext(c);
      if (h.cpu_percent !== null)
        setSamples((v) =>
          [...v, h.cpu_percent].slice(-preferences.chart_samples),
        );
      setError("");
      setUpdated(new Date().toISOString());
      setTransport("connected");
    }
    async function poll(run: number) {
      try {
        const [h, c] = await Promise.all([
          request("health"),
          call("context_get"),
        ]);
        if (disposed || run !== generation) return;
        const e = await call("events_read", {
          after: session.current === h.session_id ? cursor.current : 0,
          limit: 200,
        });
        if (disposed || run !== generation) return;
        if (c.status !== "ok" || e.status !== "ok")
          throw new Error(
            "O núcleo está ocupado; aguardando próxima consulta.",
          );
        consume(h, c.data, e.data);
      } catch (e) {
        if (!disposed && run === generation) {
          setError(e instanceof Error ? e.message : String(e));
          setTransport("connecting");
        }
      } finally {
        if (!disposed && run === generation)
          timer = setTimeout(() => poll(run), preferences.interval_ms);
      }
    }
    function start() {
      generation++;
      clearTimeout(timer);
      source?.close();
      if (preferences.pause_hidden && document.hidden) {
        setTransport("paused");
        return;
      }
      const run = generation;
      setTransport("connecting");
      if (preferences.mode === "events") {
        // A new stream begins at the start of the bounded recent-event buffer.
        session.current = "";
        cursor.current = 0;
        source = new EventSource("/api/live");
        source.addEventListener("telemetry", (event) => {
          if (disposed || run !== generation) return;
          try {
            const f = JSON.parse((event as MessageEvent).data);
            consume(f.health, f.context, f.events);
          } catch {
            setError("Resposta de telemetria inválida.");
          }
        });
        source.onerror = () => {
          if (!disposed && run === generation) {
            session.current = "";
            cursor.current = 0;
            setTransport("connecting");
            setError(
              "Conexão ao vivo interrompida. Reconectando automaticamente…",
            );
          }
        };
      } else {
        poll(run);
      }
    }
    start();
    const visibility=()=>{if(preferences.pause_hidden)start();};
    document.addEventListener("visibilitychange", visibility);
    return () => {
      disposed = true;
      generation++;
      clearTimeout(timer);
      source?.close();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [preferences]);
  useEffect(() => {
    let cancelled = false;
    if (health?.session_id)
      Promise.all([request("tools"), call("system_get_info")])
        .then(([t, s]) => {
          if (!cancelled) {
            setTools(t.tools);
            setSystem(s.data);
          }
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [health?.session_id]);
  const connected = !!health && !error;
  const nav = [
    { name: "Visão geral", icon: Activity },
    { name: "Ferramentas", icon: Layers },
    { name: "Memória", icon: Database },
    { name: "Conexão", icon: Plug },
    { name: "Configurações", icon: SlidersHorizontal },
  ];
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("Visão geral");
          }}
        >
          <span className="logo">
            N<span>↗</span>
          </span>
          <b>
            nervo<span className="version">0.1</span>
          </b>
        </a>
        <div className="workspace-label">CONSOLE DE DIAGNÓSTICO</div>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              className={tab === name ? "nav active" : "nav"}
              onClick={() => setTab(name)}
            >
              <Icon size={18} />
              {name}
              {name === "Ferramentas" && (
                <span className="count">{tools.length || "—"}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="side-note">
          <Workflow size={22} />
          <p>
            Um núcleo.
            <br />
            Múltiplos assistentes.
          </p>
          <small>
            O Nervo continua funcionando
            <br />
            quando você fecha este painel.
          </small>
        </div>
        <div className="backend-status">
          <span className={`dot ${connected ? "" : "off"}`} />
          <div>
            <b>{connected ? "Backend conectado" : "Aguardando backend"}</b>
            <small>127.0.0.1 : 47821</small>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            Nervo <ChevronRight size={13} />
            <span>{tab}</span>
          </div>
          <div className="header-right">
            <span className="local-pill">
              <span className="dot" />
              LOCAL
            </span>
            <span>Windows · sessão atual</span>
          </div>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {tab === "Visão geral"
                  ? "TELEMETRIA DO NÚCLEO"
                  : tab === "Ferramentas"
                    ? "CAPACIDADES DISPONÍVEIS"
                    : tab === "Memória"
                      ? "HISTÓRICO PERSISTIDO"
                      : tab === "Configurações"
                        ? "PREFERÊNCIAS E DESEMPENHO"
                        : "INTERFACE PARA ASSISTENTES"}
              </div>
              <h1>
                {tab === "Visão geral"
                  ? "O seu Windows, acessível."
                  : tab === "Ferramentas"
                    ? "Explore as ferramentas."
                    : tab === "Memória"
                      ? "Memória que fica."
                      : tab === "Configurações"
                        ? "No seu ritmo."
                        : "Pronto para se conectar."}
              </h1>
              <p>
                {tab === "Visão geral"
                  ? "Estado real do sistema, coleta e persistência em um só lugar."
                  : tab === "Ferramentas"
                    ? "Inspecione contratos e execute as mesmas operações disponíveis via MCP."
                    : tab === "Memória"
                      ? "Lotes Markdown factuais, organizados por data e acessíveis pela API."
                      : tab === "Configurações"
                        ? "Ajuste atualização, coleta e memória sem reiniciar o núcleo."
                        : "Um backend independente para todos os seus assistentes."}
              </p>
            </div>
            <button
              className="live"
              title="Configurar atualização"
              onClick={() => setTab("Configurações")}
            >
              <Radio size={15} />
              {transport === "paused"
                ? "Painel pausado"
                : connected
                  ? preferences.mode === "events"
                    ? "Ao vivo · eventos"
                    : `Ao vivo · ${preferences.interval_ms} ms`
                  : "Sem conexão"}
            </button>
          </div>
          {error && (
            <div className="error-banner">
              {error}
              {updated && (
                <span>
                  {" "}
                  Última resposta: {clock(updated)}. Os dados abaixo podem estar
                  desatualizados.
                </span>
              )}
            </div>
          )}
          {tab === "Configurações" && (
            <Settings preferences={preferences} onChange={setPreferences} />
          )}
          {tab === "Visão geral" && (
            <>
              <div className="metrics">
                <Metric
                  label="CPU DO NERVO"
                  icon={<Cpu size={17} />}
                  value={
                    health?.cpu_percent == null
                      ? "—"
                      : `${health.cpu_percent.toFixed(2)}%`
                  }
                  detail="Uso total normalizado pelos núcleos"
                />
                <Metric
                  label="MEMÓRIA PRIVADA"
                  icon={<Layers size={17} />}
                  value={bytes(health?.memory?.private_bytes)}
                  detail={`Residente: ${bytes(health?.memory?.working_set_bytes)}`}
                />
                <Metric
                  label="FILA DE GRAVAÇÃO"
                  icon={<HardDrive size={17} />}
                  value={bytes(health?.history?.pending_bytes)}
                  detail={`Lotes: ${health?.history?.flush_interval_ms ?? "—"} ms ou ${(health?.history?.batch_threshold_bytes ?? 0) / 1024} KiB`}
                />
                <Metric
                  label="TEMPO ATIVO"
                  icon={<Activity size={17} />}
                  value={time(health?.uptime_seconds)}
                  detail={`${health?.requests_total ?? "—"} chamadas de ferramentas`}
                />
              </div>
              <div className="overview-grid">
                <section className="panel focus">
                  <div className="panel-heading">
                    <h2>
                      <Monitor size={17} /> Contexto do desktop
                    </h2>
                    <span className="tag">WIN32</span>
                  </div>
                  <div className="focus-body">
                    <div className="window-symbol">
                      <Monitor size={29} />
                    </div>
                    <div className="tiny-label">JANELA EM PRIMEIRO PLANO</div>
                    <h3 title={context?.foreground?.title}>
                      {context?.foreground?.title ||
                        "Nenhuma janela disponível"}
                    </h3>
                    <div className="subtle mono">
                      PID {context?.foreground?.pid ?? "—"}{" "}
                      <span className="separator">/</span>{" "}
                      {context?.foreground?.window_id ?? "—"}
                    </div>
                  </div>
                  <div className="focus-details">
                    <div>
                      <MousePointer2 size={16} />
                      <span>Ponteiro</span>
                      <b className="mono">
                        {context?.input?.cursor?.x ?? "—"},{" "}
                        {context?.input?.cursor?.y ?? "—"}
                      </b>
                    </div>
                    <div>
                      <Activity size={16} />
                      <span>Sem entrada</span>
                      <b className="mono">
                        {context?.input?.idle_ms === undefined
                          ? "—"
                          : `${(context.input.idle_ms / 1000).toFixed(0)} s`}
                      </b>
                    </div>
                  </div>
                  <div className="panel-foot">
                    <span
                      className={`dot ${health?.foreground_hook_active ? "" : "off"}`}
                    />
                    {health?.foreground_hook_active
                      ? "Evento de foco conectado"
                      : "Coleta periódica de contexto"}
                    <span className="push">
                      {context?.observed_at ? clock(context.observed_at) : "—"}
                    </span>
                  </div>
                </section>
                <section className="panel performance">
                  <div className="panel-heading">
                    <h2>
                      <Activity size={17} /> Impacto local
                    </h2>
                    <span className="subtle">CPU · amostras desta página</span>
                  </div>
                  <div className="chart-value">
                    {health?.cpu_percent == null
                      ? "—"
                      : health.cpu_percent.toFixed(2)}
                    <small>%</small>
                    <span>processo nervo.exe</span>
                  </div>
                  <div className="chart">
                    <div className="chart-scale">
                      {Math.max(1, ...samples).toFixed(1)}%
                    </div>
                    <svg
                      viewBox="0 0 600 110"
                      preserveAspectRatio="none"
                      aria-label="Histórico real de utilização da CPU"
                    >
                      <defs>
                        <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
                          <stop stopColor="#b8ed83" stopOpacity=".16" />
                          <stop
                            offset="1"
                            stopColor="#b8ed83"
                            stopOpacity="0"
                          />
                        </linearGradient>
                      </defs>
                      <path
                        d={`M 0 110 ${samples.map((v, i) => `L ${(i * 600) / Math.max(1, samples.length - 1)} ${105 - (v / Math.max(1, ...samples)) * 95}`).join(" ")} L 600 110 Z`}
                        fill="url(#fill)"
                      />
                      <polyline
                        points={samples
                          .map(
                            (v, i) =>
                              `${(i * 600) / Math.max(1, samples.length - 1)},${105 - (v / Math.max(1, ...samples)) * 95}`,
                          )
                          .join(" ")}
                        fill="none"
                        stroke="#b8ed83"
                        strokeWidth="2"
                        vectorEffect="non-scaling-stroke"
                      />
                    </svg>
                    <div className="chart-axis">
                      <span>{samples.length} amostras</span>
                      <span>agora</span>
                    </div>
                  </div>
                  <div className="machine">
                    <Cpu size={16} />
                    <span>
                      {system?.cpu_name ||
                        "Aguardando informações do processador"}
                    </span>
                    <span className="push">
                      {system?.logical_processors ?? "—"} threads
                    </span>
                  </div>
                </section>
              </div>
              <div className="bottom-grid">
                <section className="panel events">
                  <div className="panel-heading">
                    <h2>
                      <Radio size={17} /> Atividade recente
                    </h2>
                    <span className="tag">{events.length} EVENTOS</span>
                  </div>
                  {gap && (
                    <div className="warning">
                      Há uma lacuna no buffer recente. Consulte o histórico em
                      disco.
                    </div>
                  )}
                  <div className="event-list">
                    {events.length === 0 ? (
                      <div className="empty">Aguardando eventos da sessão.</div>
                    ) : (
                      events
                        .slice(-6)
                        .reverse()
                        .map((e) => (
                          <div className="event" key={e.id}>
                            <span className="event-icon">
                              {e.kind === "window_changed" ? (
                                <Monitor size={15} />
                              ) : e.kind === "clipboard_changed" ? (
                                <Clipboard size={15} />
                              ) : (
                                <Terminal size={15} />
                              )}
                            </span>
                            <div>
                              <b>
                                {(
                                  {
                                    window_changed: "Janela ativa alterada",
                                    clipboard_changed:
                                      "Área de transferência alterada",
                                    backend_started: "Núcleo iniciado",
                                    operation_completed: "Operação concluída",
                                  } as Obj
                                )[e.kind] || e.kind}
                              </b>
                              <p>{e.data?.title || e.data?.tool || e.source}</p>
                            </div>
                            <time>{clock(e.at)}</time>
                          </div>
                        ))
                    )}
                  </div>
                  <button
                    className="text-button panel-link"
                    onClick={() => setTab("Memória")}
                  >
                    Explorar histórico persistido <ArrowUpRight size={15} />
                  </button>
                </section>
                <section className="panel persistence">
                  <div className="panel-heading">
                    <h2>
                      <Database size={17} /> Persistência
                    </h2>
                    <span
                      className={`dot ${health?.history?.last_error ? "off" : ""}`}
                    />
                  </div>
                  <div className="storage-icon">
                    <Database size={27} />
                  </div>
                  <h3>
                    {health?.history?.last_error
                      ? "Gravação com erro"
                      : "Memória em Markdown"}
                  </h3>
                  <p>
                    A coleta e as consultas continuam
                    <br />
                    durante a gravação em lotes.
                  </p>
                  <dl>
                    <div>
                      <dt>Eventos persistidos</dt>
                      <dd>{health?.history?.persisted_events ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Lotes gravados</dt>
                      <dd>{health?.history?.batches ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Eventos descartados</dt>
                      <dd
                        className={
                          health?.history?.dropped_events ? "danger" : ""
                        }
                      >
                        {health?.history?.dropped_events ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>Última gravação</dt>
                      <dd>
                        {health?.history?.last_flush_at
                          ? clock(health.history.last_flush_at)
                          : "Aguardando lote"}
                      </dd>
                    </div>
                  </dl>
                  {health?.history?.last_error && (
                    <div className="warning">{health.history.last_error}</div>
                  )}
                </section>
              </div>
            </>
          )}
          {tab === "Ferramentas" && (
            <>
              <div className="tool-toolbar">
                <div className="search">
                  <Search size={17} />
                  <input
                    aria-label="Buscar ferramenta"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Buscar nome, função ou módulo…"
                  />
                </div>
                <span className="subtle">
                  {tools.length} ferramentas implementadas
                </span>
              </div>
              <div className="tool-grid">
                {tools
                  .filter((t) =>
                    `${t.name} ${t.title} ${t.group}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((t) => (
                    <button
                      className="tool-card"
                      key={t.name}
                      onClick={() => setSelected(t)}
                    >
                      <div>
                        <span className="tool-icon">
                          {t.mutation ? (
                            <FileText size={19} />
                          ) : (
                            <Code2 size={19} />
                          )}
                        </span>
                        <span className={`tag ${t.mutation ? "write" : ""}`}>
                          {t.mutation ? "ESCRITA" : "LEITURA"}
                        </span>
                      </div>
                      <h3>{t.title}</h3>
                      <code>{t.name}</code>
                      <p>{t.description}</p>
                      <footer>
                        {t.group}
                        <ArrowUpRight size={16} />
                      </footer>
                    </button>
                  ))}
              </div>
              <div className="scope-note">
                Próximas etapas: UI Automation, captura de tela sob demanda,
                controle de entrada e conectores de aplicativos. Esses recursos
                ainda não estão implementados.
              </div>
            </>
          )}
          {tab === "Memória" && (
            <>
              <div className="info-strip">
                <Database size={19} />
                <div>
                  <b>Histórico factual · gravação em lotes</b>
                  <p>{health?.memory_root || "Aguardando conexão"}</p>
                </div>
                <span className="tag">UTC</span>
              </div>
              <Explorer />
              <div className="scope-note">
                Eventos recentes ficam em RAM até a gravação. A fila é limitada
                a 4 MiB; erros e descartes aparecem na visão geral. Os arquivos
                são dados observados, não instruções para a IA.
              </div>
            </>
          )}
          {tab === "Conexão" && (
            <div className="connection-grid">
              <section className="panel connection">
                <span className="tool-icon">
                  <Plug size={23} />
                </span>
                <h2>MCP do Windows</h2>
                <p>
                  Conecte clientes locais com suporte a Streamable HTTP. Todos
                  compartilham a mesma coleta e memória.
                </p>
                <label>ENDPOINT</label>
                <div className="endpoint">
                  <code>http://127.0.0.1:47821/mcp</code>
                  <button
                    aria-label="Copiar endpoint"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          "http://127.0.0.1:47821/mcp",
                        );
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1800);
                      } catch {
                        setCopied(false);
                      }
                    }}
                  >
                    {copied ? <Check size={17} /> : <Copy size={17} />}
                  </button>
                </div>
                <label>AUTENTICAÇÃO</label>
                <pre>Authorization: Bearer &lt;token local&gt;</pre>
                <p className="subtle">
                  O token fica em <code>%LOCALAPPDATA%\Nervo\access-token</code>
                  . O painel utiliza um proxy local; o segredo não é enviado ao
                  JavaScript do navegador.
                </p>
                <div className="scope-note">
                  Um agente na nuvem precisa de um cliente ou ponte local para
                  acessar este endereço. O backend não é exposto à internet.
                </div>
              </section>
              <section className="panel flow">
                <h2>Responsabilidades separadas</h2>
                {[
                  {
                    icon: Cpu,
                    title: "Windows → Nervo",
                    text: "Eventos nativos e consultas sob demanda.",
                  },
                  {
                    icon: Workflow,
                    title: "Nervo → assistentes",
                    text: "Dados estruturados via MCP. Raciocínio na nuvem.",
                  },
                  {
                    icon: Database,
                    title: "Nervo → memória",
                    text: "Histórico Markdown com fila independente.",
                  },
                  {
                    icon: Monitor,
                    title: "Nervo → este painel",
                    text: "Diagnóstico opcional. Pode fechar quando quiser.",
                  },
                ].map(({ icon: Icon, title, text }) => (
                  <div className="flow-item" key={title}>
                    <Icon size={20} />
                    <div>
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </div>
                  </div>
                ))}
                <div className="scope-note">
                  Arquivos podem ser criados e alterados somente na pasta de
                  trabalho configurada.
                  <br />
                  <code>{health?.workspace}</code>
                </div>
              </section>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <span className={`dot ${connected ? "" : "off"}`} />{" "}
              {connected
                ? "Dados reais · APIs nativas do Windows"
                : "Dados indisponíveis ou desatualizados"}
            </span>
            <span>
              {updated
                ? `Atualizado às ${clock(updated)}`
                : "Conectando ao núcleo…"}{" "}
              <span className="separator">/</span> Nervo v0.1.0
            </span>
          </footer>
        </div>
      </main>
      {selected && (
        <ToolDialog tool={selected} close={() => setSelected(undefined)} />
      )}
    </div>
  );
}
function Metric({
  label,
  icon,
  value,
  detail,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  detail: string;
}) {
  return (
    <section className="metric">
      <div>
        {label}
        {icon}
      </div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </section>
  );
}
function ToolDialog({ tool, close }: { tool: Tool; close: () => void }) {
  const [args, setArgs] = useState(
      JSON.stringify(examples[tool.name] || {}, null, 2),
    ),
    [result, setResult] = useState<Obj>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  async function run() {
    setBusy(true);
    setError("");
    try {
      setResult(await call(tool.name, JSON.parse(args)));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-title"
      >
        <div className="panel-heading">
          <h2 id="tool-title">{tool.title}</h2>
          <button aria-label="Fechar ferramenta" onClick={close}>
            <X size={20} />
          </button>
        </div>
        <code>{tool.name}</code>
        <p>{tool.description}</p>
        <label htmlFor="tool-args">ARGUMENTOS JSON</label>
        <textarea
          ref={box}
          id="tool-args"
          spellCheck={false}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <details>
          <summary>Ver contrato de entrada</summary>
          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
        </details>
        {tool.mutation && (
          <div className="warning">
            Esta operação altera arquivos na pasta de trabalho. Para editar um
            arquivo existente, leia sua versão com files_read e informe
            expected_version.
          </div>
        )}
        <button className="primary" disabled={busy} onClick={run}>
          <Play size={15} />
          {busy
            ? "Executando…"
            : tool.mutation
              ? "Executar escrita"
              : "Executar consulta"}
        </button>
        {error && <div className="error-banner">{error}</div>}
        {result && (
          <>
            <div className="result-heading">
              <span className={result.status === "ok" ? "success" : "danger"}>
                {result.status === "ok"
                  ? "✓ Operação concluída"
                  : "Operação retornou erro"}
              </span>
              <span>{result.elapsed_ms?.toFixed(2)} ms</span>
            </div>
            <pre className="result">{JSON.stringify(result, null, 2)}</pre>
          </>
        )}
      </section>
    </div>
  );
}
function Explorer() {
  const [path, setPath] = useState(""),
    [items, setItems] = useState<Obj[]>([]),
    [file, setFile] = useState<Obj>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [next, setNext] = useState<number | null>(null);
  async function load(p: string, offset = 0) {
    setBusy(true);
    setError("");
    try {
      const r = await call("memory_list", { path: p, offset, limit: 200 });
      if (r.status !== "ok") throw new Error(r.error.message);
      setItems((v) => (offset ? [...v, ...r.data.items] : r.data.items));
      setNext(r.data.next_cursor);
      setPath(p);
      setFile(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    load("");
  }, []);
  async function more() {
    if (!file) return;
    try {
      const r = await call("memory_read", {
        path: file.path,
        byte_offset: file.next_byte_offset,
      });
      if (r.status !== "ok") throw new Error(r.error.message);
      setFile({ ...r.data, text: file.text + r.data.text });
    } catch (e) {
      setError(String(e));
    }
  }
  async function open(i: Obj) {
    if (i.directory) {
      load(i.path);
      return;
    }
    setError("");
    try {
      const r = await call("memory_read", { path: i.path });
      if (r.status !== "ok") throw new Error(r.error.message);
      setFile(r.data);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="panel explorer">
      <div className="panel-heading">
        <h2>
          <Folder size={17} />
          <span>memory / {path.replaceAll("\\", " / ")}</span>
        </h2>
        <div>
          <button
            disabled={!path || busy}
            onClick={() => load(path.split(/[\\/]/).slice(0, -1).join("/"))}
          >
            Voltar
          </button>
          <button
            aria-label="Atualizar memória"
            disabled={busy}
            onClick={() => load(path)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      {error && <div className="error-banner">{error}</div>}
      <div className="file-list">
        {items.length === 0 && (
          <div className="empty">
            {busy ? "Carregando…" : "Nenhum arquivo nesta pasta."}
          </div>
        )}
        {items.map((i) => (
          <button className="file-row" key={i.path} onClick={() => open(i)}>
            {i.directory ? <Folder size={18} /> : <FileText size={18} />}
            <span>{i.name}</span>
            <small>{i.directory ? "Pasta" : bytes(i.bytes)}</small>
            <ChevronRight size={16} />
          </button>
        ))}
        {next !== null && (
          <button className="text-button" onClick={() => load(path, next)}>
            Carregar mais
          </button>
        )}
      </div>
      {file && (
        <div className="file-preview">
          <h3>
            <FileText size={17} />
            {file.path}
          </h3>
          {file.truncated && (
            <div className="warning">
              Há mais conteúdo disponível neste arquivo.
            </div>
          )}
          <pre>{file.text}</pre>
          {file.next_byte_offset !== null && (
            <button className="text-button" onClick={more}>
              Ler próximo bloco
            </button>
          )}
        </div>
      )}
    </section>
  );
}
