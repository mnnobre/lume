import { useEffect, useRef, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { api, ago, PROVIDERS, projectName, type ImageIn, type LiveEvent, type Message, type Session } from "./api";

type Approval = { request_id: string; tool: string; detail: string };
type LiveTurn = { text: string; tools: Message[]; approvals: Approval[] };

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

const isCommand = (m: Message) => ["Bash", "PowerShell", "Comando"].includes(m.text);

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

function ToolGroup({ tools, running }: { tools: Message[]; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const n = tools.length;
  const verb = running ? "Executando" : "Executado";
  const label = tools.every(isCommand)
    ? `${verb} ${n} ${n === 1 ? "comando" : "comandos"}`
    : `${running ? "Usando" : "Usou"} ${n} ${n === 1 ? "ferramenta" : "ferramentas"}`;
  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen(!open)}>
        {running && <span className="spinner" />}
        <span>{label}</span>
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

// ---------- chat ----------

export function Chat({ session, notify }: { session: Session; notify: (m: string) => void }) {
  const [messages, setMessages] = useState<Message[] | null | undefined>(undefined); // undefined = carregando
  const [live, setLive] = useState<LiveTurn | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<{ preview: string; image: ImageIn }[]>([]);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = () => api.transcript(session).then((r) => setMessages(r.messages)).catch((e) => notify(String(e)));

  // conversa do arquivo (fonte da verdade); sem turno ao vivo, acompanha mudanças feitas pelo app a cada 4 s
  useEffect(() => {
    setMessages(undefined);
    setLive(null);
    atEnd.current = true;
    reload();
    const t = setInterval(() => !liveRef.current && reload(), 4000);
    return () => clearInterval(t);
  }, [session.provider, session.id]);

  // eventos ao vivo do agente
  useEffect(() => {
    const un = api.onLive((e: LiveEvent) => {
      if (e.provider !== session.provider || e.id !== session.id) return;
      setLive((cur) => {
        const l = cur ?? { text: "", tools: [], approvals: [] };
        switch (e.kind) {
          case "delta":
            return { ...l, text: l.text + e.text };
          case "tool":
            return { ...l, tools: [...l.tools, { role: "tool", text: e.name, title: e.title, detail: e.detail }] };
          case "approval":
            return { ...l, approvals: [...l.approvals, { request_id: e.request_id, tool: e.tool, detail: e.detail }] };
          case "done":
            if (e.error) notify(e.error);
            reload(); // o turno terminou: relê do arquivo e some com a prévia
            return null;
        }
      });
    });
    return () => void un.then((f) => f());
  }, [session.provider, session.id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoomed(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function send() {
    if (!text.trim() && !attachments.length) return;
    const t = text, imgs = attachments;
    setText("");
    setAttachments([]);
    atEnd.current = true;
    setMessages((m) => [...(m ?? []), { role: "user", text: t, images: imgs.map((a) => a.preview) }]);
    setLive({ text: "", tools: [], approvals: [] });
    try {
      await api.send(session, t, imgs.map((a) => a.image));
    } catch (e) {
      notify(String(e));
      setLive(null);
      setText(t);
      setAttachments(imgs);
      reload();
    }
  }

  async function answer(a: Approval, allow: boolean) {
    setLive((l) => l && { ...l, approvals: l.approvals.filter((x) => x.request_id !== a.request_id) });
    await api.answer(session, a.request_id, allow).catch((e) => notify(String(e)));
  }

  async function addFiles(files: FileList | File[]) {
    const imgs = [...files].filter((f) => f.type.startsWith("image/"));
    const read = await Promise.all(imgs.map(readFile));
    setAttachments((a) => [...a, ...read]);
  }

  const jumpToEnd = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const readable = session.provider !== "antigravity";

  return (
    <section className="chat">
      <header className="chat-head" data-tauri-drag-region>
        <span className={`dot ${session.provider}`} />
        <div className="chat-title">
          <h2 title={session.title}>{session.title}</h2>
          <p>{PROVIDERS[session.provider]} · {projectName(session.project)} · {ago(session.updated)}</p>
        </div>
        <button className="btn" onClick={() => api.open(session).catch((e) => notify(String(e)))}>Abrir no app</button>
      </header>

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
          {messages === null && <p className="hint">O Antigravity não deixa ler a conversa fora do app. Use “Abrir no app”.</p>}
          {messages?.length === 0 && <p className="hint">Sem mensagens ainda.</p>}
          {messages &&
            blocks(messages).map((b, i) =>
              b.kind === "tools" ? <ToolGroup key={i} tools={b.tools} /> : <Bubble key={i} m={b.m} zoom={setZoomed} />,
            )}

          {live && (
            <>
              {live.tools.length > 0 && <ToolGroup tools={live.tools} running={!live.text} />}
              {live.approvals.map((a) => (
                <div key={a.request_id} className="approval">
                  <div className="approval-text">
                    <b>{PROVIDERS[session.provider]} quer usar {a.tool}</b>
                    {a.detail && <code>{a.detail}</code>}
                  </div>
                  <div className="approval-actions">
                    <button className="btn" onClick={() => answer(a, false)}>Negar</button>
                    <button className="btn primary" onClick={() => answer(a, true)}>Permitir</button>
                  </div>
                </div>
              ))}
              <div className="turn assistant">
                {live.text ? (
                  <div className="md"><Md text={live.text} zoom={setZoomed} /></div>
                ) : (
                  !live.approvals.length && <div className="typing"><span /><span /><span /></div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {showJump && (
        <button className="jump" onClick={jumpToEnd} aria-label="Ir para o fim">
          <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 3v10M3.5 8.5L8 13l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}

      {readable && (
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
                    <img src={a.preview} alt="" onClick={() => setZoomed(a.preview)} />
                    <button onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} aria-label="Remover">×</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              rows={1}
              value={text}
              placeholder={`Responder no ${PROVIDERS[session.provider]}…`}
              onChange={(e) => {
                setText(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 220) + "px";
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
                  if (!live) send();
                }
              }}
            />
            <div className="composer-bar">
              <button className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Anexar imagem" title="Anexar imagem">
                <svg width="16" height="16" viewBox="0 0 16 16"><path d="M13.5 7.5l-5.6 5.6a3.3 3.3 0 0 1-4.7-4.7l5.8-5.8a2.2 2.2 0 0 1 3.1 3.1L6.3 11.5a1.1 1.1 0 0 1-1.6-1.6l5.2-5.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
              </button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
              <span className="composer-hint">{live ? "Respondendo…" : "Enter envia · Shift+Enter quebra linha"}</span>
              {live ? (
                <button className="send stop" onClick={() => api.interrupt(session).catch((e) => notify(String(e)))} aria-label="Parar" title="Parar">
                  <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" rx="2" fill="currentColor" /></svg>
                </button>
              ) : (
                <button className="send" disabled={!text.trim() && !attachments.length} onClick={send} aria-label="Enviar">
                  <svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
            </div>
          </div>
        </div>
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
