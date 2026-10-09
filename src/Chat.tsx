import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api, ago, PROVIDERS, projectName, type ImageIn, type TurnOptions, type Message, type Session } from "./api";
import { activityOf, markIdle, markWorking, useActivity } from "./liveStatus";

import { useLiveView, startRuntime } from "./runtime";
import { RequestCard } from "./Requests";
import { ModelSelector } from "./ModelSelector";
import { GitBar, ModeSelector, PlusMenu } from "./ComposerParts";
import { UsageRing } from "./usage";
import { ProviderIcon } from "./ProviderIcon";
import { useCodexIntegrations } from "./codexComposer";
import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

// ---------- peças pequenas ----------

function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy-btn"
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? (
        <svg width="13" height="13" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
      )}
    </button>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chev ${open ? "open" : ""}`} width="10" height="10" viewBox="0 0 10 10">
    <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const textOf = (n: ReactNode): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : (n as any)?.props ? textOf((n as any).props.children) : "";

function resolvePath(filePath: string, project?: string): string {
  let clean = filePath.replace(/^file:\/\/\/?/, "");
  if (/^\/[a-zA-Z]:/.test(clean)) {
    clean = clean.slice(1);
  }
  clean = clean.split("#")[0];
  if (/^[a-zA-Z]:[\\\/]/.test(clean) || clean.startsWith("\\\\") || clean.startsWith("/")) {
    return clean;
  }
  if (project) {
    const normProj = project.replace(/[\/\\]+$/, "");
    return `${normProj}/${clean}`;
  }
  return clean;
}

const handleOpenFile = (path: string, project?: string) => {
  const full = resolvePath(path, project);
  openPath(full).catch(() => {
    if (project) api.openFolder(project).catch(() => {});
  });
};

const handleRevealFile = (path: string, project?: string, e?: React.MouseEvent) => {
  e?.stopPropagation();
  const full = resolvePath(path, project);
  revealItemInDir(full).catch(() => {
    if (project) api.openFolder(project).catch(() => {});
  });
};

function Md({ text, zoom, project }: { text: string; zoom: (src: string) => void; project?: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false }]]}
      components={{
        a: ({ href, children }) => {
          const url = href ?? "";
          const childText = textOf(children);
          const isFile =
            url.startsWith("file://") ||
            url.startsWith("vscode://") ||
            /\.(tsx?|jsx?|rs|py|json|css|html|md|ya?ml|toml|sql|c|cpp|h|go|java|sh|ps1)(\b|#|$)/i.test(url) ||
            /\.(tsx?|jsx?|rs|py|json|css|html|md|ya?ml|toml|sql|c|cpp|h|go|java|sh|ps1)(\b|#|$)/i.test(childText);

          if (isFile) {
            const rawTarget = url || childText;
            const clean = resolvePath(rawTarget, project);
            const lineMatch = /#L?(\d+(?:[-–]\d+)?)/i.exec(url || childText);
            const lineLabel = lineMatch ? lineMatch[1] : null;
            const displayName =
              childText.replace(/#L?\d+.*$/i, "").replace(/^file:\/\/\/?/, "").split(/[\\\/]/).slice(-2).join("/") ||
              childText;

            return (
              <a
                href={url || "#"}
                className="file-chip"
                title={clean}
                onClick={(e) => {
                  e.preventDefault();
                  handleOpenFile(clean, project);
                }}
              >
                <svg className="file-chip-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5z" />
                  <polyline points="9 1.5 9 6 13.5 6" />
                </svg>
                <span className="file-chip-name">{displayName}</span>
                {lineLabel && <span className="file-chip-line">:{lineLabel}</span>}
              </a>
            );
          }

          return (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="web-link"
              onClick={(e) => {
                if (url.startsWith("http://") || url.startsWith("https://")) {
                  e.preventDefault();
                  openUrl(url).catch(() => window.open(url, "_blank"));
                }
              }}
            >
              {children}
            </a>
          );
        },
        pre: ({ children }) => {
          const lang = /language-(\w+)/.exec((children as any)?.props?.className ?? "")?.[1];
          return (
            <div className="code-block">
              <div className="code-head">
                <span>{lang ?? "código"}</span>
                <CopyButton text={textOf(children).replace(/\n$/, "")} label="Copiar código" />
              </div>
              <pre>{children}</pre>
            </div>
          );
        },
        img: ({ src, alt }) => <img src={src} alt={alt} onClick={() => src && zoom(src)} />,
      }}
    >
      {text}
    </Markdown>
  );
}

// ---------- ferramentas: agrupadas e colapsáveis, como no Claude ----------

const isCommand = (m: Message) => ["Bash", "PowerShell", "Comando", "run_command"].includes(m.text);

function toolLabel(m: Message) {
  if (m.title) return m.title;
  if (m.detail) return `${m.text} · ${m.detail}`;
  return m.text;
}

function ToolItem({ m }: { m: Message }) {
  const [open, setOpen] = useState(false);
  const expandable = !!(m.input || m.output);
  return (
    <div className={`tool-item ${open ? "open" : ""} ${m.failed ? "failed" : ""}`}>
      <button className="tool-line" onClick={() => expandable && setOpen(!open)} disabled={!expandable}>
        <span className="tool-label">{toolLabel(m)}</span>
        {m.failed && <span className="tool-fail">falhou</span>}
        {(m.added || m.removed) ? <span className="diffstat"><span className="plus">+{m.added ?? 0}</span> <span className="minus">−{m.removed ?? 0}</span></span> : null}
        {expandable && <Chevron open={open} />}
      </button>
      {open && (
        <div className="tool-body">
          {m.input && (
            <div className="tool-section">
              <div className="tool-section-head"><span>{isCommand(m) ? "Comando" : "Entrada"}</span><CopyButton text={m.input} /></div>
              <pre>{m.input}</pre>
            </div>
          )}
          {m.output && (
            <div className="tool-section">
              <div className="tool-section-head"><span>Saída</span><CopyButton text={m.output} /></div>
              <pre>{m.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const KINDS: { match: string[]; one: string; many: (n: number) => string }[] = [
  { match: ["Bash", "PowerShell", "Comando", "run_command"], one: "executou um comando", many: (n) => `executou ${n} comandos` },
  { match: ["Read", "view_file"], one: "leu um arquivo", many: (n) => `leu ${n} arquivos` },
  { match: ["Write", "write_to_file"], one: "criou um arquivo", many: (n) => `criou ${n} arquivos` },
  { match: ["Edit", "MultiEdit", "Editar arquivos", "NotebookEdit", "replace_file_content"], one: "editou um arquivo", many: (n) => `editou ${n} arquivos` },
  { match: ["Grep", "Glob", "ToolSearch"], one: "fez uma busca", many: (n) => `fez ${n} buscas` },
  { match: ["WebSearch", "Busca na web", "search_web"], one: "pesquisou na web", many: (n) => `pesquisou na web ${n} vezes` },
  { match: ["WebFetch", "read_url_content"], one: "abriu uma página", many: (n) => `abriu ${n} páginas` },
  { match: ["Task", "Agent", "invoke_subagent", "Subagente"], one: "delegou uma tarefa", many: (n) => `delegou ${n} tarefas` },
];
const baseName = (p?: string) => p?.split(/[\\/]/).pop();

function summarize(tools: Message[]) {
  const parts: { text: string; n: number; first: Message }[] = [];
  for (const m of tools) {
    const kind = KINDS.find((k) => k.match.includes(m.text));
    const label = kind ? kind.one : `usou ${m.text}`;
    const part = parts.find((p) => p.text === label);
    part ? part.n++ : parts.push({ text: label, n: 1, first: m });
  }
  const phrases = parts.map(({ text, n, first }) => {
    const kind = KINDS.find((k) => k.one === text);
    if (n > 1) return kind ? kind.many(n) : `${text} ${n} vezes`;
    // uma ação só: mostra o arquivo, como o Claude ("criou probe_agy.py")
    const file = ["Write", "Edit", "MultiEdit", "Read", "write_to_file", "replace_file_content", "view_file"].includes(first.text) && baseName(first.detail);
    return file ? text.replace(/um arquivo$/, file) : text;
  });
  const shown = phrases.slice(0, 3);
  const rest = phrases.length - shown.length;
  const out = rest > 0 ? `${shown.join(", ")} e mais ${rest} ${rest === 1 ? "ação" : "ações"}` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} e ${shown[shown.length - 1]}` : shown[0] ?? "";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function ToolGroup({ tools, running }: { tools: Message[]; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const n = tools.length;
  const added = tools.reduce((a, m) => a + (m.added ?? 0), 0);
  const removed = tools.reduce((a, m) => a + (m.removed ?? 0), 0);
  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen(!open)}>
        {running && <span className="spinner" />}
        <span className="tool-summary">{summarize(tools)}</span>
        {(added > 0 || removed > 0) && (
          <span className="diffstat"><span className="plus">+{added}</span> <span className="minus">−{removed}</span></span>
        )}
        <Chevron open={open} />
      </button>
      {open && <div className="tool-list">{tools.map((m, i) => <ToolItem key={i} m={m} />)}</div>}
      {!open && running && <div className="tool-latest">{toolLabel(tools[n - 1])}</div>}
    </div>
  );
}

type ChangedFile = {
  name: string;
  fullPath: string;
  added: number;
  removed: number;
};

function extractChangedFiles(tools?: Message[]): ChangedFile[] {
  if (!tools || tools.length === 0) return [];
  const map = new Map<string, ChangedFile>();
  for (const m of tools) {
    const isEdit =
      (m.added !== undefined && m.added > 0) ||
      (m.removed !== undefined && m.removed > 0) ||
      ["Edit", "MultiEdit", "Write", "write_to_file", "replace_file_content", "NotebookEdit"].includes(m.text);
    if (!isEdit) continue;
    const rawPath = m.detail || m.title || "";
    if (!rawPath) continue;
    const name = baseName(rawPath) || rawPath;
    const existing = map.get(name) || { name, fullPath: rawPath, added: 0, removed: 0 };
    existing.added += m.added || 0;
    existing.removed += m.removed || 0;
    if (rawPath.length > existing.fullPath.length) {
      existing.fullPath = rawPath;
    }
    map.set(name, existing);
  }
  return Array.from(map.values());
}

function FilesChangedBar({ files, project }: { files: ChangedFile[]; project?: string }) {
  const [open, setOpen] = useState(false);
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  return (
    <div className="files-changed-wrap">
      <div className="files-changed-bar">
        <button
          className="files-changed-pill"
          onClick={() => setOpen(!open)}
          type="button"
          title="Ver arquivos alterados neste passo"
        >
          <svg className="fc-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5z" />
            <polyline points="9 1.5 9 6 13.5 6" />
          </svg>
          <span className="fc-label">
            {files.length} {files.length === 1 ? "arquivo alterado" : "arquivos alterados"}
          </span>
          {(totalAdded > 0 || totalRemoved > 0) && (
            <span className="diffstat">
              {totalAdded > 0 && <span className="plus">+{totalAdded}</span>}
              {totalRemoved > 0 && <span className="minus">−{totalRemoved}</span>}
            </span>
          )}
          <Chevron open={open} />
        </button>
        <button
          className="btn small fc-review-btn"
          onClick={() => {
            if (!open) setOpen(true);
            else if (project) api.openFolder(project).catch(() => {});
          }}
          type="button"
          title={open ? "Abrir pasta do projeto" : "Revisar arquivos"}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="3" y="3" width="10" height="10" rx="1.5" />
            <path d="M6 7h4M6 10h3" />
          </svg>
          <span>Revisar</span>
        </button>
      </div>

      {open && (
        <div className="files-changed-list">
          {files.map((f, i) => (
            <div
              key={i}
              className="files-changed-item"
              onClick={() => handleOpenFile(f.fullPath, project)}
              title={`Abrir ${f.fullPath}`}
            >
              <svg className="file-chip-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M9 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V6L9 1.5z" />
                <polyline points="9 1.5 9 6 13.5 6" />
              </svg>
              <span className="fc-item-name">{f.name}</span>
              <span className="fc-item-path">{f.fullPath !== f.name ? f.fullPath : ""}</span>
              {(f.added > 0 || f.removed > 0) && (
                <span className="diffstat">
                  {f.added > 0 && <span className="plus">+{f.added}</span>}
                  {f.removed > 0 && <span className="minus">−{f.removed}</span>}
                </span>
              )}
              <div className="fc-item-actions">
                <button
                  className="icon-btn"
                  title="Abrir arquivo no editor"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenFile(f.fullPath, project);
                  }}
                  type="button"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
                  </svg>
                </button>
                <button
                  className="icon-btn"
                  title="Mostrar na pasta (Explorer)"
                  onClick={(e) => handleRevealFile(f.fullPath, project, e)}
                  type="button"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Junta ferramentas seguidas num grupo só e associa as ferramentas ao turno do assistente. */
function blocks(messages: Message[]) {
  const out: ({ kind: "msg"; m: Message; tools?: Message[] } | { kind: "tools"; tools: Message[] })[] = [];
  let pendingTools: Message[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      pendingTools.push(m);
    } else {
      if (m.role === "assistant") {
        if (pendingTools.length > 0) {
          out.push({ kind: "tools", tools: [...pendingTools] });
          out.push({ kind: "msg", m, tools: [...pendingTools] });
          pendingTools = [];
        } else {
          out.push({ kind: "msg", m });
        }
      } else {
        if (pendingTools.length > 0) {
          out.push({ kind: "tools", tools: [...pendingTools] });
          pendingTools = [];
        }
        out.push({ kind: "msg", m });
      }
    }
  }
  if (pendingTools.length > 0) {
    out.push({ kind: "tools", tools: pendingTools });
  }
  return out;
}

function Bubble({
  m,
  tools,
  project,
  zoom,
}: {
  m: Message;
  tools?: Message[];
  project?: string;
  zoom: (src: string) => void;
}) {
  const changedFiles = useMemo(() => extractChangedFiles(tools), [tools]);
  return (
    <div className={`turn ${m.role}`}>
      {m.images?.map((src, i) => <img key={i} className="msg-img" src={src} alt="" onClick={() => zoom(src)} />)}
      {m.text &&
        (m.role === "user" ? (
          <div className="user-text">{m.text}</div>
        ) : (
          <div className="md"><Md text={m.text} project={project} zoom={zoom} /></div>
        ))}
      {m.role === "assistant" && changedFiles.length > 0 && (
        <FilesChangedBar files={changedFiles} project={project} />
      )}
      {m.text && (
        <div className="turn-footer">
          <div className="turn-meta">
            {m.timestamp ? <span className="turn-time">{ago(m.timestamp)}</span> : null}
          </div>
          <div className="turn-actions">
            <CopyButton text={m.text} label="Copiar mensagem" />
          </div>
        </div>
      )}
    </div>
  );
}

function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Ícone animado do "trabalhando" (os pontinhos que giram, como no Claude). */
const Working = ({ waiting }: { waiting?: boolean }) => (
  <span className={`working-icon ${waiting ? "waiting" : ""}`}><span /><span /><span /><span /></span>
);

/** Linha ao vivo no fim da conversa: o que a IA está fazendo agora + segundos do passo. */
function LiveRow({ doing, since, waiting }: { doing: string; since: number; waiting?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className={`live-row ${waiting ? "waiting" : ""}`}>
      <Working waiting={waiting} />
      <span className="live-doing">{doing}</span>
      <span className="live-time">{elapsed(Date.now() - since)}</span>
    </div>
  );
}

/** Última coisa que aconteceu na conversa (para quando ela roda no app). */
function lastAction(messages: Message[]) {
  const m = messages[messages.length - 1];
  if (!m) return "trabalhando";
  if (m.role === "tool") return toolLabel(m);
  return m.role === "user" ? "pensando" : "escrevendo";
}

const readFile = (f: File) =>
  new Promise<{ preview: string; image: ImageIn }>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      ok({ preview: url, image: { media_type: f.type || "image/png", data: url.slice(url.indexOf(",") + 1) } });
    };
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });

/** Os "⋮" do cabeçalho: abre um menu e fecha ao clicar fora ou escolher um item. */
function HeadMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="head-menu-wrap" onClick={(e) => e.stopPropagation()}>
      <button className={`icon-btn ${open ? "on" : ""}`} title="Mais opções" aria-label="Mais opções" onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="3.5" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="12.5" r="1.2" fill="currentColor" /></svg>
      </button>
      {open && <div className="head-menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

// ---------- caixa de mensagem ----------

type Attachment = { preview: string; image: ImageIn };

/**
 * Estado próprio (texto e anexos): cada tecla redesenha só a caixa, não a conversa inteira
 * (Markdown + destaque de sintaxe de centenas de mensagens travavam a digitação).
 */
const Composer = memo(function Composer({
  session,
  busy,
  options,
  onOptionsChange,
  notify,
  onSend,
  onQueue,
  above,
  onStop,
  onZoom,
  currentModel,
  currentMode,
  onCompact,
  context,
  settingsNotice,
}: {
  session: Session;
  busy: boolean;
  options: TurnOptions;
  onOptionsChange: (o: TurnOptions) => void;
  notify?: (m: string) => void;
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean>;
  /** com a IA ocupada, o envio vai para a fila */
  onQueue?: (text: string, attachments: Attachment[]) => void;
  above?: ReactNode;
  onStop: () => void;
  onZoom: (src: string) => void;
  currentModel?: string;
  currentMode?: string;
  onCompact?: () => void;
  context?: [number, number];
  settingsNotice?: string;
}) {
  // rascunho por conversa: o que você começou a digitar volta quando você reabre a conversa
  const draftKey = `lume.draft.${session.provider}:${session.id || "nova:" + session.project}`;
  const [text, setText] = useState(() => localStorage.getItem(draftKey) ?? "");
  useEffect(() => {
    try {
      text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey);
    } catch {}
  }, [text]);
  useEffect(() => void requestAnimationFrame(resize), []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const area = useRef<HTMLTextAreaElement>(null);

  const resize = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  };

  async function addFiles(files: FileList | File[]) {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    const read = await Promise.all(imgs.map(readFile));
    setAttachments((a) => [...a, ...read]);
  }

  const hasInput = !!text.trim() || attachments.length > 0;
  async function send() {
    if (!hasInput || (busy && !onQueue)) return;
    const t = text, imgs = attachments;
    setText("");
    setAttachments([]);
    requestAnimationFrame(resize);
    if (busy) return onQueue!(t, imgs);
    if (!(await onSend(t, imgs))) {
      // falhou: devolve o que foi digitado
      setText(t);
      setAttachments(imgs);
    }
  }

  const [listening, setListening] = useState(false);
  const insert = (t: string) => {
    setText((cur) => (cur && !cur.endsWith(" ") ? cur + " " : cur) + t);
    requestAnimationFrame(() => (area.current?.focus(), resize()));
  };
  const integrations = useCodexIntegrations(session, insert, (mention) => onOptionsChange({
    ...options, mentions: [...(options.mentions ?? []).filter((m) => m.path !== mention.path), mention],
  }));
  const dictate = async () => {
    if (listening) return;
    setListening(true);
    try {
      const r = await invoke<{ text: string }>("pet_dictate"); // reconhecimento de fala do Windows, no próprio PC
      if (r.text) insert(r.text);
    } catch (e) {
      notify?.(String(e));
    } finally {
      setListening(false);
    }
  };
  return (
    <div className="composer-wrap">
      {above}
      <GitBar session={session} refreshKey={busy} onAsk={!busy ? (prompt) => void onSend(prompt, []) : undefined} />
      <div
        className="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        {attachments.length > 0 && (
          <div className="attachments">
            {attachments.map((a, i) => (
              <div key={i} className="attachment">
                <img src={a.preview} alt="" onClick={() => onZoom(a.preview)} />
                <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} aria-label="Remover">×</button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={busy && onQueue ? "Escreva para a fila…" : session.provider === "antigravity" ? "Ask anything, @ to mention, / for actions" : `Responder no ${PROVIDERS[session.provider]}…`}
          onChange={(e) => {
            setText(e.target.value);
            resize();
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.some((f) => f.type.startsWith("image/"))) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
            {busy && !(onQueue && hasInput) ? (
              <button className="send stop" onClick={onStop} aria-label="Parar" title="Parar">
                <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
              </button>
            ) : (
              <button className="send" disabled={!hasInput} onClick={send} aria-label={busy ? "Pôr na fila" : "Enviar"} title={busy ? "Pôr na fila (vai quando o turno acabar)" : undefined}>
                <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
        </div>
      </div>
        <div className="composer-bar">
          <div className="composer-bar-left">
            <PlusMenu
              notify={notify}
              groups={integrations.groups}
              onOpen={integrations.load}
              onImages={(imgs) => setAttachments((a) => [...a, ...imgs])}
              onInsert={insert}
              onSlash={() => (setText((t) => (t.startsWith("/") ? t : "/" + t)), requestAnimationFrame(() => area.current?.focus()))}
            />
            <button type="button" className={`composer-icon-btn mic-btn ${listening ? "on" : ""}`} onClick={dictate} disabled={listening}
              aria-label="Ditar mensagem" title={listening ? "Ouvindo por até 12 s…" : "Ditar mensagem · Português (Brasil)"}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 2z"/><path d="M4 7.5a4 4 0 0 0 8 0M8 12v2.5M6 14.5h4"/></svg>
            </button>
            <ModeSelector provider={session.provider} mode={options.mode ?? currentMode} onChange={(mode) => onOptionsChange({ ...options, mode })} />
          </div>
          <div className="composer-bar-right">
            <ModelSelector
              session={session}
              options={options}
              onChange={onOptionsChange}
              notify={notify}
              currentModel={currentModel}
            />
            <UsageRing provider={session.provider} context={context} onCompact={!busy ? (session.provider === "claude" ? () => void onSend("/compact", []) : session.provider === "codex" ? onCompact : session.provider === "antigravity" ? () => void onSend("/compact", []) : undefined) : undefined} />
          </div>
        </div>
        {settingsNotice && <div className="composer-settings-notice" role="status">{settingsNotice}</div>}
    </div>
  );
});

// ---------- configuração lembrada (modelo, esforço, permissões) ----------

/** Por conversa; `efforts` guarda o esforço de cada modelo usado nela. A "last" do provider vale para conversas novas. */
type SavedOptions = Pick<TurnOptions, "model" | "effort" | "mode"> & { efforts?: Record<string, string | undefined> };
const optsKey = (s: Session) => (s.id ? `lume.opts.${s.provider}:${s.id}` : `lume.opts.last.${s.provider}`);
const readOpts = (k: string): SavedOptions | null => {
  try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; }
};
function saveOpts(s: Session, o: SavedOptions) {
  try {
    const v = JSON.stringify({ model: o.model, effort: o.effort, mode: o.mode, efforts: o.efforts });
    localStorage.setItem(optsKey(s), v);
    localStorage.setItem(`lume.opts.last.${s.provider}`, v);
  } catch {}
}
const loadOpts = (s: Session): SavedOptions => readOpts(optsKey(s)) ?? {};

// ---------- fila: mensagens escritas enquanto a IA trabalha ----------

type Queued = { id: number; text: string; attachments: Attachment[] };
// ponytail: fila em memória por conversa; só anda com a conversa aberta e some ao fechar o Lume
const queues = new Map<string, Queued[]>();

function QueueList({ items, onNow, onRemove }: { items: Queued[]; onNow: (q: Queued) => void; onRemove: (q: Queued) => void }) {
  if (!items.length) return null;
  return (
    <div className="queue">
      {items.map((q, i) => (
        <div key={q.id} className="queue-item">
          <span className="queue-tag">{i === 0 ? "Próxima" : "Na fila"}</span>
          <span className="queue-text" title={q.text}>{q.text || `${q.attachments.length} imagem(ns)`}</span>
          <button className="btn small" onClick={() => onNow(q)} title="Interrompe o turno atual e manda esta mensagem já">Enviar agora</button>
          <button className="icon-btn small" onClick={() => onRemove(q)} title="Tirar da fila" aria-label="Tirar da fila">×</button>
        </div>
      ))}
    </div>
  );
}

// ---------- chat ----------

export function Chat({ session, notify, onCreated, archived = false, onChanged, pinned = false, onPin }: { session: Session; notify: (m: string) => void; onCreated: (s: Session) => void; archived?: boolean; onChanged?: () => void; pinned?: boolean; onPin?: () => void }) {
  const draft = !session.id; // conversa nova: só vira sessão no primeiro envio
  const [messages, setMessages] = useState<Message[] | null | undefined>(undefined); // undefined = carregando
  const view = useLiveView(session);
  const [model, setModel] = useState<string | undefined>();
  const [context, setContext] = useState<[number, number] | undefined>();
  const live = view?.busy ? view : null;
  const [sending, setSending] = useState(false);
  const [saved] = useState(() => loadOpts(session));
  const [options, setOptionsState] = useState<TurnOptions>(() => ({ model: saved.model, effort: saved.effort, mode: saved.mode }));
  const optionsRef = useRef(options);
  const optionsEdited = useRef(false);
  const modeUpdates = useRef<Promise<void>>(Promise.resolve());
  const modeRevision = useRef(0);
  const confirmedMode = useRef(saved.mode);
  const [settingsNotice, setSettingsNotice] = useState("");
  const efforts = useRef(saved.efforts ?? {});
  const setOptions = (o: TurnOptions) => {
    // trocou de modelo: volta o esforço que você usou nele nesta conversa
    const previous = optionsRef.current;
    const next = o.model !== previous.model && efforts.current[o.model ?? ""] ? { ...o, effort: efforts.current[o.model ?? ""] } : o;
    optionsEdited.current = true;
    optionsRef.current = next;
    efforts.current = { ...efforts.current, [next.model ?? ""]: next.effort };
    setOptionsState(next);
    saveOpts(session, { ...next, efforts: efforts.current });
    if (next.mode && next.mode !== previous.mode && session.id) {
      const mode = next.mode;
      const revision = ++modeRevision.current;
      setSettingsNotice("Aplicando permissão…");
      // Preserve selection order even if native requests take different times.
      modeUpdates.current = modeUpdates.current.then(async () => {
        try {
          const result = await api.setMode(session, mode);
          confirmedMode.current = mode;
          if (modeRevision.current === revision) setSettingsNotice(result.detail);
        } catch (error) {
          if (modeRevision.current === revision) {
            const restored = {...optionsRef.current, mode: confirmedMode.current};
            optionsRef.current = restored;
            setOptionsState(restored);
            saveOpts(session, {...restored, efforts: efforts.current});
            setSettingsNotice("Não foi possível aplicar a permissão. A configuração anterior foi mantida.");
          }
          notify(String(error));
        }
      });
    } else if (next.model !== previous.model || next.effort !== previous.effort) {
      setSettingsNotice("Modelo e esforço serão usados no próximo envio, inclusive nas mensagens da fila.");
    }
  };
  const [currentMode, setCurrentMode] = useState<string>();
  useEffect(() => {
    if (session.provider !== "codex" || !session.id) return;
    let active = true;
    api.manage(session.id, "read").then((r) => {
      if (!active || !r?.thread) return;
      setCurrentMode(r.thread.mode ?? "custom");
      if (r.thread.model) setModel(r.thread.model);
      // Do not overwrite changes made while the request was in flight, and do
      // not turn displayed permissions into an override of a custom sandbox.
      if (!optionsEdited.current) {
        const current = optionsRef.current;
        const loaded = {...current,
          ...(current.model == null && r.thread.model ? {model: r.thread.model} : {}),
          ...(current.effort == null && r.thread.reasoningEffort ? {effort: r.thread.reasoningEffort} : {}),
        };
        optionsRef.current = loaded;
        setOptionsState(loaded);
      }
    }).catch((e) => active && notify(String(e)));
    return () => { active = false; };
  }, [session.provider, session.id]);
  const [limit, setLimit] = useState(400);
  const [hasMore, setHasMore] = useState(false);
  const [optimistic, setOptimistic] = useState<Message | null>(null);
  const optimisticRef = useRef(optimistic); optimisticRef.current = optimistic;
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const activity = activityOf(useActivity(), session);
  const [external, setExternal] = useState<number | null>(null);
  const [externalDetail,setExternalDetail] = useState("");
  const stamp = useRef<string | null>(null);
  const reloadRef = useRef<()=>void>(()=>{});
  useEffect(() => {
    let disposed = false, loading = false;
    let timer: ReturnType<typeof setTimeout>;
    setMessages(draft ? [] : undefined); stamp.current = null; atEnd.current = true;
    if (draft) return;
    const reload = async () => {
      if (disposed || loading) return;
      loading = true;
      try {
        const r = await api.transcript(session,limit);
        if (disposed) return;
        if (r.model || session.provider !== "codex") setModel(r.model);
        setContext(r.context);
        if (stamp.current !== r.revision) {
          stamp.current=r.revision;setMessages(r.messages);setHasMore(r.has_more);
          const pending=optimisticRef.current;
          if(pending && r.messages?.slice(-40).some(m=>m.role==="user"&&m.text===pending.text)) setOptimistic(null);
        }
        setExternal(r.active ? r.updated : null); setExternalDetail(r.activity);
      } catch(e) { if(!disposed) notify(String(e)); }
      finally {loading=false;}
    };
    reloadRef.current=()=>void reload();
    const loop=async()=>{await reload();if(!disposed)timer=setTimeout(loop,1500);};
    void loop();
    const focused=()=>void reload();window.addEventListener("focus",focused);
    return()=>{disposed=true;clearTimeout(timer);window.removeEventListener("focus",focused);};
  }, [session.provider,session.id,limit]);
  useEffect(()=>{ if(view && !view.busy) {reloadRef.current(); if(view.error)notify(view.error);} },[view?.busy,view?.error]);
  useEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoomed(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function compact() {
    if (session.provider !== "codex" || draft || sending || view?.busy || external) return;
    setSending(true);
    try {
      await startRuntime();
      await api.manage(session.id, "compact");
    } catch (e) { notify(String(e)); }
    finally { setSending(false); }
  }

  async function send(t: string, imgs: Attachment[]): Promise<boolean> {
    atEnd.current = true;
    setOptimistic({role:"user",text:t,images:imgs.map(a=>a.preview)});
    setSending(true);
    try { await startRuntime(); } catch(e) {notify(String(e));setSending(false);return false;}
    await modeUpdates.current;
    const sendOptions = {...optionsRef.current};
    if (draft) {
      try {
        const created = await api.newChat(session.provider, session.project, t, imgs.map((a) => a.image), sendOptions);
        saveOpts(created, { ...optionsRef.current, efforts: efforts.current }); // preserve choices made while creation was in flight

        onCreated(created); // remonta o chat já com o id; os eventos ao vivo seguem chegando
        setSending(false);setOptimistic(null);return true;
      } catch (e) {
        notify(String(e));
        setSending(false);setOptimistic(null);
        setMessages([]);
        return false;
      }
    }
    markWorking(session.provider, session.id);
    try {
      await api.send(session, t, imgs.map((a) => a.image), sendOptions);
      setSending(false);return true;
    } catch (e) {
      notify(String(e));
      markIdle(session.provider, session.id);
      setSending(false);setOptimistic(null);
      stamp.current = null; // força reler: tira a mensagem que não foi enviada
      reloadRef.current();
      return false;
    }
  }

  // fila: o que você manda com a IA ocupada espera o turno acabar e vai sozinho, na ordem
  const qKey = `${session.provider}:${session.id}`;
  const [queue, setQueueState] = useState<Queued[]>(() => queues.get(qKey) ?? []);
  const setQueue = (f: (q: Queued[]) => Queued[]) => setQueueState((cur) => { const n = f(cur); queues.set(qKey, n); return n; });
  const queueRef = useRef(queue); queueRef.current = queue;
  const halted = useRef(false); // um envio da fila falhou: para até você mexer nela (senão tenta em loop)
  const busyNow = !!live || sending || !!external;
  const busyRef = useRef(busyNow); busyRef.current = busyNow;
  const sendQueued = (q: Queued) => {
    setQueue((all) => all.filter((x) => x.id !== q.id));
    void send(q.text, q.attachments).then((ok) => {
      if (!ok) { halted.current = true; setQueue((all) => [q, ...all]); }
    });
  };
  useEffect(() => {
    if (busyNow || draft) return;
    // espera um pouco: o "trabalhando" do turno recém-enviado pode chegar depois da resposta do envio
    const t = setTimeout(() => {
      const next = queueRef.current[0];
      if (next && !busyRef.current && !halted.current) sendQueued(next);
    }, 800);
    return () => clearTimeout(t);
  }, [busyNow]);
  const enqueue = (text: string, attachments: Attachment[]) => {
    halted.current = false;
    setQueue((all) => [...all, { id: Date.now() + Math.random(), text, attachments }]);
  };
  const sendNow = (q: Queued) => {
    halted.current = false;
    if (!busyRef.current) return sendQueued(q);
    setQueue((all) => [q, ...all.filter((x) => x.id !== q.id)]); // vira a próxima e vai assim que o turno parar
    api.interrupt(session).catch((e) => notify(String(e)));
  };

  const jumpToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const readable = true;
  const history = useMemo(
    () =>
      messages &&
      blocks(messages).map((b, i) =>
        b.kind === "tools" ? (
          <ToolGroup key={i} tools={b.tools} />
        ) : (
          <Bubble key={i} m={b.m} tools={b.tools} project={session.project} zoom={setZoomed} />
        ),
      ),
    [messages, session.project],
  );

  return (
    <section className="chat">
      <header className="chat-head" data-drag>
        <ProviderIcon p={session.provider} />
        <div className="chat-title">
          <h2 title={session.title}>{session.title}</h2>
          <p>{projectName(session.project)} · {ago(session.updated)}</p>
        </div>
        <div className="head-icons">
          <button className="icon-btn" title="Abrir pasta do projeto" aria-label="Abrir pasta do projeto"
            onClick={() => api.openFolder(session.project).catch((e) => notify(String(e)))}>
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
          </button>
          <HeadMenu>
            <button className="menu-item" disabled={draft} onClick={() => api.open(session).catch((e) => notify(String(e)))}>
              <svg className="check" width="14" height="14" viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              <span className="grow">Abrir no {PROVIDERS[session.provider]}</span>
            </button>
            {session.provider === "codex" && session.id && (
              <>
                <div className="menu-sep" />
                <button className="menu-item" onClick={onPin}><span className="check">{pinned ? "★" : "☆"}</span><span className="grow">{pinned ? "Desafixar" : "Fixar no Lume"}</span></button>
                <button className="menu-item" onClick={() => setRename(session.title)}><span className="check" /><span className="grow">Renomear</span></button>
                <button className="menu-item" disabled={!!live || !!external}
                  onClick={() => api.manage(session.id, archived ? "unarchive" : "archive").then(() => onChanged?.()).catch((e) => notify(String(e)))}>
                  <span className="check" /><span className="grow">{archived ? "Restaurar" : "Arquivar"}</span>
                </button>
              </>
            )}
          </HeadMenu>
        </div>
      </header>

      {rename!==null && <form className="rename-bar" onSubmit={e=>{e.preventDefault();api.manage(session.id,"rename",rename).then(()=>{setRename(null);onChanged?.();}).catch(e=>notify(String(e)));}}><input autoFocus aria-label="Título da conversa" value={rename} onChange={e=>setRename(e.target.value)}/><button className="btn primary">Salvar título</button><button type="button" className="btn" onClick={()=>setRename(null)}>Cancelar</button></form>}
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          setShowJump(!atEnd.current);
        }}
      >
        <div className="thread">
          {messages === undefined && <p className="hint">Carregando…</p>}
          {messages === null && <p className="hint">Não foi possível carregar o histórico desta conversa. Use “Abrir no app”.</p>}
          {messages?.length === 0 && !live && (
            <div className="empty-chat">
              {draft ? (
                <>
                  <ProviderIcon p={session.provider} />
                  <h2>Nova conversa no {PROVIDERS[session.provider]}</h2>
                  <p>em {session.project}</p>
                </>
              ) : (
                <p className="hint">Sem mensagens ainda.</p>
              )}
            </div>
          )}
          {hasMore && <button className="btn history-more" onClick={()=>setLimit(l=>l+400)}>Carregar mensagens anteriores</button>}
          {history}
          {optimistic && <Bubble m={optimistic} zoom={setZoomed}/>}
          {sending && !live && <LiveRow doing="Enviando…" since={Date.now()}/> }

          {live && (
            <>
              {live.tools.length > 0 && <ToolGroup tools={live.tools} running={!live.text} />}
              {live.requests.map(r=><RequestCard key={r.request_id} request={r} session={session} notify={notify}/>)}
              {live.text && !messages?.some(m=>m.role==="assistant" && m.text===live.text) && (
                <div className="turn assistant">
                  <div className="md"><Md text={live.text} zoom={setZoomed} /></div>
                </div>
              )}
              <LiveRow
                doing={activity?.doing ?? "Pensando…"}
                since={activity?.stepSince ?? live.since}
                waiting={activity?.state === "waiting"}
              />
            </>
          )}
          {!live && external && messages && (
            <LiveRow doing={`Em andamento no ${PROVIDERS[session.provider]} · ${externalDetail || lastAction(messages)}`} since={external} />
          )}
        </div>
      </div>

      {showJump && (
        <button className="jump" onClick={jumpToEnd} aria-label="Ir para o fim">
          <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}

      {readable && !archived && (
        <Composer
          session={session}
          busy={!!live || sending}
          options={options}
          onOptionsChange={setOptions}
          notify={notify}
          onSend={send}
          onQueue={draft ? undefined : enqueue}
          above={<QueueList items={queue} onNow={sendNow} onRemove={(q) => setQueue((all) => all.filter((x) => x.id !== q.id))} />}
          onStop={() => api.interrupt(session).catch((e) => notify(String(e)))}
          onZoom={setZoomed}
          currentModel={model}
          settingsNotice={settingsNotice}
          currentMode={currentMode}
          onCompact={!draft && !external ? () => void compact() : undefined}
          context={view?.busy ? view.context ?? context : context ?? view?.context ?? undefined}
        />
      )}

      {zoomed && (
        <div className="lightbox" onClick={() => setZoomed(null)}>
          <img src={zoomed} alt="" onClick={(e) => e.stopPropagation()} />
          <button className="lightbox-close" onClick={() => setZoomed(null)} aria-label="Fechar">×</button>
        </div>
      )}
    </section>
  );
}
