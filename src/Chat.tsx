import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api, ago, PROVIDERS, projectName, type ImageIn, type TurnOptions, type Message, type Session } from "./api";
import { activityOf, markIdle, markWorking, useActivity } from "./liveStatus";

import { useLiveView, startRuntime } from "./runtime";
import { RequestCard } from "./Requests";
import { ModelSelector } from "./ModelSelector";

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

function Md({ text, zoom }: { text: string; zoom: (src: string) => void }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: false }]]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
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

/** Junta ferramentas seguidas num grupo só. */
function blocks(messages: Message[]) {
  const out: ({ kind: "msg"; m: Message } | { kind: "tools"; tools: Message[] })[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (m.role === "tool") last?.kind === "tools" ? last.tools.push(m) : out.push({ kind: "tools", tools: [m] });
    else out.push({ kind: "msg", m });
  }
  return out;
}

function Bubble({ m, zoom }: { m: Message; zoom: (src: string) => void }) {
  return (
    <div className={`turn ${m.role}`}>
      {m.images?.map((src, i) => <img key={i} className="msg-img" src={src} alt="" onClick={() => zoom(src)} />)}
      {m.text &&
        (m.role === "user" ? (
          <div className="user-text">{m.text}</div>
        ) : (
          <div className="md"><Md text={m.text} zoom={zoom} /></div>
        ))}
      {m.text && (
        <div className="turn-actions">
          <CopyButton text={m.text} label="Copiar mensagem" />
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
  onStop,
  onZoom,
  currentModel,
}: {
  session: Session;
  busy: boolean;
  options: TurnOptions;
  onOptionsChange: (o: TurnOptions) => void;
  notify?: (m: string) => void;
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean>;
  onStop: () => void;
  onZoom: (src: string) => void;
  currentModel?: string;
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
  const fileInput = useRef<HTMLInputElement>(null);
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

  async function send() {
    if (busy || (!text.trim() && !attachments.length)) return;
    const t = text, imgs = attachments;
    setText("");
    setAttachments([]);
    requestAnimationFrame(resize);
    if (!(await onSend(t, imgs))) {
      // falhou: devolve o que foi digitado
      setText(t);
      setAttachments(imgs);
    }
  }

  return (
    <div className="composer-wrap">
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
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={session.provider === "antigravity" ? "Ask anything, @ to mention, / for actions" : `Responder no ${PROVIDERS[session.provider]}…`}
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
        <div className="composer-bar">
          <div className="composer-bar-left">
            <button className="composer-icon-btn" onClick={() => fileInput.current?.click()} aria-label="Anexar arquivo" title="Anexar arquivo ou imagem">
              <svg width="15" height="15" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
            </button>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
            <ModelSelector
              session={session}
              options={options}
              onChange={onOptionsChange}
              disabled={busy}
              notify={notify}
              currentModel={currentModel}
            />
          </div>
          <div className="composer-bar-right">
            <button type="button" className="composer-icon-btn mic-btn" aria-label="Gravação de voz" title="Voz">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 2a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 2z"/><path d="M4 7.5a4 4 0 0 0 8 0M8 12v2.5M6 14.5h4"/></svg>
            </button>
            {busy ? (
              <button className="send stop" onClick={onStop} aria-label="Parar" title="Parar">
                <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
              </button>
            ) : (
              <button className="send" disabled={!text.trim() && !attachments.length} onClick={send} aria-label="Enviar">
                <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// ---------- chat ----------

export function Chat({ session, notify, onCreated, archived = false, onChanged, pinned = false, onPin }: { session: Session; notify: (m: string) => void; onCreated: (s: Session) => void; archived?: boolean; onChanged?: () => void; pinned?: boolean; onPin?: () => void }) {
  const draft = !session.id; // conversa nova: só vira sessão no primeiro envio
  const [messages, setMessages] = useState<Message[] | null | undefined>(undefined); // undefined = carregando
  const view = useLiveView(session);
  const [model, setModel] = useState<string | undefined>();
  const live = view?.busy ? view : null;
  const [sending, setSending] = useState(false);
  const [options, setOptions] = useState<TurnOptions>({});
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
        setModel(r.model);
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

  async function send(t: string, imgs: Attachment[]): Promise<boolean> {
    atEnd.current = true;
    setOptimistic({role:"user",text:t,images:imgs.map(a=>a.preview)});
    setSending(true);
    try { await startRuntime(); } catch(e) {notify(String(e));setSending(false);return false;}
    if (draft) {
      try {
        const created = await api.newChat(session.provider, session.project, t, imgs.map((a) => a.image), options);

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
      await api.send(session, t, imgs.map((a) => a.image), options);
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

  const jumpToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const readable = true;
  const history = useMemo(
    () =>
      messages &&
      blocks(messages).map((b, i) =>
        b.kind === "tools" ? <ToolGroup key={i} tools={b.tools} /> : <Bubble key={i} m={b.m} zoom={setZoomed} />,
      ),
    [messages],
  );

  return (
    <section className="chat">
      <header className="chat-head" data-drag>
        <span className={`dot ${session.provider}`} />
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
                  <span className={`dot ${session.provider}`} />
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
          onStop={() => api.interrupt(session).catch((e) => notify(String(e)))}
          onZoom={setZoomed}
          currentModel={model}
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
