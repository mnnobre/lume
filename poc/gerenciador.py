"""POC: gerenciador de sessões Claude Code / Codex / Antigravity agrupadas por projeto.
Lê os arquivos locais de cada ferramenta, mostra a conversa e manda mensagens pela CLI do provider
(ou abre no app desktop) — o harness continua no provider.
Uso: python gerenciador.py  ->  http://127.0.0.1:8765
"""
import glob, json, os, re, shutil, sqlite3, subprocess, sys, threading, time, webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

HOME = os.path.expanduser("~")
PORT = 8765
SESSIONS = {}  # (provider, id) -> sessão; preenchido a cada /api/sessions
RUNNING = {}  # (provider, id) -> None enquanto a CLI roda, ou texto do erro


def norm_path(p):
    p = unquote(p or "")
    p = re.sub(r"^file:///", "", p).replace("/", "\\")
    p = re.sub(r"^\\\\\?\\", "", p).rstrip("\\")
    p = re.sub(r"\\\.claude\\worktrees\\[^\\]+$", "", p, flags=re.I)  # worktree conta como o projeto
    if re.match(r"^[a-zA-Z]:$", p):
        p += "\\"
    return p[:1].upper() + p[1:] if p else p


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def sqlite_ro(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def claude_sessions():
    out = []
    for f in glob.glob(os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")):
        cwd = first_prompt = title = None
        with open(f, "rb") as fh:  # cabeça: cwd + primeiro prompt
            for i, line in enumerate(fh):
                if i > 300 or (cwd and first_prompt):
                    break
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                cwd = cwd or o.get("cwd")
                if not first_prompt and o.get("type") == "user" and not o.get("isMeta"):
                    c = (o.get("message") or {}).get("content")
                    if isinstance(c, list):
                        c = next((x.get("text") for x in c if x.get("type") == "text"), None)
                    if isinstance(c, str) and not c.startswith("<"):
                        first_prompt = c
            # cauda: título mais recente (custom/ai-title), sem ler arquivos de centenas de MB inteiros
            fh.seek(max(0, os.path.getsize(f) - 256 * 1024))
            for line in fh.read().splitlines():
                if b"title" in line or b'"summary"' in line:
                    try:
                        o = json.loads(line)
                    except ValueError:
                        continue
                    title = o.get("customTitle") or o.get("aiTitle") or o.get("summary") or title
        if not (title or first_prompt):
            continue
        out.append(dict(provider="claude", id=os.path.basename(f)[:-6],
                        project=norm_path(cwd) if cwd else os.path.basename(os.path.dirname(f)),
                        title=title or first_prompt, updated=iso(os.path.getmtime(f)), file=f))
    return out


def codex_sessions():
    db = os.path.join(HOME, ".codex", "state_5.sqlite")
    if not os.path.exists(db):
        return []
    with sqlite_ro(db) as c:
        rows = c.execute("select id, cwd, coalesce(nullif(name,''), nullif(title,''), first_user_message), "
                         "updated_at, rollout_path from threads where archived = 0").fetchall()
    return [dict(provider="codex", id=i, project=norm_path(cwd), title=t or "(sem título)", updated=iso(u),
                 file=norm_path(f)) for i, cwd, t, u, f in rows]


def antigravity_sessions():
    db = os.path.join(HOME, ".gemini", "antigravity", "conversation_summaries.db")
    if not os.path.exists(db):
        return []
    with sqlite_ro(db) as c:
        rows = c.execute("select conversation_id, coalesce(nullif(title,''), preview), workspace_uris, "
                         "last_modified_time from conversation_summaries where killed = 0").fetchall()
    out = []
    for i, t, ws, upd in rows:
        uris = json.loads(ws or "[]")
        out.append(dict(provider="antigravity", id=i, project=norm_path(uris[0]) if uris else "(sem projeto)",
                        title=t or "(sem título)",
                        updated=datetime.fromisoformat(upd[:26] + upd[-6:]).isoformat()))
    return out


def all_sessions():
    out = []
    for fn in (claude_sessions, codex_sessions, antigravity_sessions):
        try:
            out += fn()
        except Exception as e:  # um provider quebrado não derruba os outros
            print(f"[{fn.__name__}] {e}", file=sys.stderr)
    SESSIONS.clear()
    SESSIONS.update({(s["provider"], s["id"]): s for s in out})
    return out


NEEDLES = {"claude": (b'"type":"user"', b'"type":"assistant"'),
           "codex": (b'"UserMessage"', b'"AgentMessage"', b'"CommandExecution"', b'"user_message"', b'"agent_message"')}
TRANSCRIPTS = {}  # arquivo -> ((mtime, tamanho), mensagens); o polling de 3 s não relê arquivos de 100 MB


def json_lines(path, needles):
    with open(path, "rb") as fh:
        for line in fh:
            if any(n in line for n in needles):  # só decodifica linhas que podem ser mensagem
                try:
                    yield json.loads(line)
                except ValueError:
                    pass


def texts(content):
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content or [] if str(c.get("type", "")).lower() == "text")


def transcript(s):
    """Mensagens [{role, text}] lidas do arquivo de sessão do provider."""
    st = os.stat(s["file"])
    hit = TRANSCRIPTS.get(s["file"])
    if hit and hit[0] == (st.st_mtime, st.st_size):
        return hit[1]
    out = []

    def add(role, text):
        if text and text.strip() and (not out or out[-1] != {"role": role, "text": text}):
            out.append({"role": role, "text": text})

    for o in json_lines(s["file"], NEEDLES[s["provider"]]):
        if s["provider"] == "claude":
            msg = o.get("message") or {}
            if o.get("type") == "user" and not o.get("isMeta"):
                t = texts(msg.get("content"))
                if not t.startswith("<"):
                    add("user", t)
            elif o.get("type") == "assistant":
                for c in msg.get("content") or []:
                    if c.get("type") == "text":
                        add("assistant", c["text"])
                    elif c.get("type") == "tool_use":
                        add("tool", c.get("name", "tool"))
        else:  # codex: formato novo (item_completed) e antigo (user_message/agent_message)
            p = o.get("payload") or {}
            it = p.get("item") or {}
            if it.get("type") == "UserMessage" or p.get("type") == "user_message":
                add("user", texts(it.get("content")) if it else p.get("message"))
            elif it.get("type") == "AgentMessage" or p.get("type") == "agent_message":
                add("assistant", texts(it.get("content")) if it else p.get("message"))
            elif it.get("type") == "CommandExecution":
                add("tool", ((it.get("command") or [""])[-1])[:200])  # último arg = o comando de fato
    out = out[-300:]  # ponytail: só as últimas 300 mensagens na tela
    TRANSCRIPTS[s["file"]] = ((st.st_mtime, st.st_size), out)
    return out


def codex_exe():
    if shutil.which("codex"):
        return shutil.which("codex")
    # WindowsApps não deixa listar a pasta; pergunta ao Windows onde o pacote do Codex app está
    loc = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-AppxPackage OpenAI.Codex).InstallLocation"],
                         capture_output=True, text=True).stdout.strip()
    exe = os.path.join(loc, "app", "resources", "codex.exe")
    return exe if loc and os.path.exists(exe) else None


BUSY_SECONDS = 120


def busy_elsewhere(s):
    # ponytail: heurística por mtime — arquivo mexido há < 2 min = outro processo (app) escrevendo nele.
    # O app não expõe "sessão ativa" de forma confiável (sessão nova nem leva o id na linha de comando).
    return time.time() - os.path.getmtime(s["file"]) < BUSY_SECONDS


def send(s, prompt):
    """Manda um turno pela CLI do provider; a resposta cai no mesmo arquivo de sessão."""
    key = (s["provider"], s["id"])
    if s["provider"] == "claude":
        cmd = [shutil.which("claude") or "claude", "-p", "--resume", s["id"]]
    elif s["provider"] == "codex":
        cmd = [codex_exe() or "codex", "exec", "--skip-git-repo-check", "resume", s["id"], "-"]
    else:
        raise ValueError("Antigravity não tem CLI para continuar a conversa; use Abrir no app")
    if key in RUNNING and RUNNING[key] is None:
        raise ValueError("essa sessão já está respondendo")
    if busy_elsewhere(s):
        raise ValueError("essa sessão está em uso no app agora (mexeu há menos de 2 min); "
                         "mande por lá ou espere ela ficar parada")
    RUNNING[key] = None

    def run():
        # sem as variáveis CLAUDE* herdadas (ex.: servidor iniciado de dentro de uma sessão do app desktop),
        # senão a CLI se apresenta como filha daquela sessão
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("CLAUDE")}
        r = subprocess.run(cmd, input=prompt, cwd=s["project"], capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env=env, creationflags=subprocess.CREATE_NO_WINDOW)
        out = (r.stdout + r.stderr).strip()
        RUNNING[key] = "" if r.returncode == 0 else (out[-600:] or f"saiu com código {r.returncode}")
    threading.Thread(target=run, daemon=True).start()


def app_link(provider, cwd, session_id=None):
    """Deep link do app desktop de cada provider (rotas lidas dos bundles dos apps)."""
    if provider == "claude":  # resume importa a sessão da CLI ou só abre, se já estiver no app
        return f"claude://resume?session={quote(session_id)}" if session_id else f"claude://code/new?folder={quote(cwd)}"
    if provider == "codex":
        return f"codex://threads/{quote(session_id)}" if session_id else f"codex://threads/new?path={quote(cwd)}"
    return None


def antigravity_exe():
    p = os.path.join(HOME, "AppData", "Local", "Programs", "Antigravity", "Antigravity.exe")
    return p if os.path.exists(p) else None


def launch(provider, cwd, session_id=None):
    if not os.path.isdir(cwd):
        raise ValueError(f"pasta não existe: {cwd}")
    if provider == "antigravity":
        # ponytail: o app só tem deep link de import do AI Studio; abre o app e a conversa fica na lista dele
        subprocess.Popen([antigravity_exe() or "antigravity"])
    elif provider in ("claude", "codex"):
        os.startfile(app_link(provider, cwd, session_id))  # abre no app já logado, sem login novo
    else:
        raise ValueError("provider inválido")


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/":
            self._send(200, PAGE, "text/html")
        elif self.path == "/api/sessions":
            self._send(200, json.dumps([{k: v for k, v in s.items() if k != "file"} for s in all_sessions()]))
        elif self.path.startswith("/api/transcript"):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            s = SESSIONS.get((q.get("provider"), q.get("id")))
            if not s:
                return self._send(404, '{"error":"sessão desconhecida"}')
            if not s.get("file"):
                return self._send(200, json.dumps({"messages": None, "running": False}))
            st = RUNNING.get((s["provider"], s["id"]), "")
            self._send(200, json.dumps({"messages": transcript(s), "running": st is None, "error": st or None}))
        else:
            self._send(404, "{}")

    def do_POST(self):
        if self.path not in ("/api/open", "/api/send") or \
                self.headers.get("Origin", "") not in ("", f"http://127.0.0.1:{PORT}"):
            return self._send(403, '{"error":"forbidden"}')
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            if self.path == "/api/send":
                if not str(req.get("text", "")).strip():
                    raise ValueError("mensagem vazia")
                send(SESSIONS[(req["provider"], req["id"])], req["text"])
            elif req.get("id"):  # retomar: dados vêm do índice do servidor, nunca do cliente
                s = SESSIONS[(req["provider"], req["id"])]
                launch(s["provider"], s["project"], s["id"])
            else:  # nova sessão: só em projeto já conhecido
                if req["project"] not in {s["project"] for s in SESSIONS.values()}:
                    raise ValueError("projeto desconhecido")
                launch(req["provider"], req["project"])
            self._send(200, '{"ok":true}')
        except Exception as e:
            self._send(400, json.dumps({"error": str(e)}))

    def log_message(self, *a):
        pass


PAGE = r"""<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Gerenciador de Sessões</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--mut:#6b6b66;--line:#e3e3df;
--claude:#c96442;--codex:#2f6fde;--antigravity:#1a9a6b}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201f;--fg:#ececea;--mut:#9a9a94;--line:#33332f}}
*{box-sizing:border-box}body{margin:0;font:14px/1.4 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;background:var(--bg);padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;flex-wrap:wrap;align-items:center}
h1{font-size:16px;margin:0 12px 0 0}input[type=search]{flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
label{color:var(--mut);user-select:none}main{padding:16px 20px;max-width:1100px;margin:auto}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:10px}
summary{padding:10px 14px;cursor:pointer;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
summary b{font-size:14px}.path{color:var(--mut);font-size:12px;flex:1}
.row{display:flex;gap:10px;align-items:center;padding:7px 14px;border-top:1px solid var(--line)}
.row .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row .d{color:var(--mut);font-size:12px;white-space:nowrap}
.tag{font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;color:#fff;white-space:nowrap}
.claude{background:var(--claude)}.codex{background:var(--codex)}.antigravity{background:var(--antigravity)}
button{font:inherit;font-size:12px;padding:4px 9px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--mut)}.new button{border-style:dashed}#msg{color:var(--mut);font-size:12px}
.row .t{cursor:pointer}.row .t:hover{text-decoration:underline}
#panel{position:fixed;top:0;right:0;bottom:0;width:min(640px,100%);background:var(--card);border-left:1px solid var(--line);display:none;flex-direction:column;box-shadow:-8px 0 24px #0003}
#panel.on{display:flex}#ph{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center}
#ph b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#pm{flex:1;overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.m{white-space:pre-wrap;word-break:break-word;padding:8px 10px;border-radius:8px;max-width:92%}
.m.user{align-self:flex-end;background:var(--bg);border:1px solid var(--line)}.m.assistant{align-self:flex-start}
.m.tool{align-self:flex-start;color:var(--mut);font:12px ui-monospace,monospace;padding:2px 10px}
#pf{border-top:1px solid var(--line);padding:10px;display:flex;gap:8px}#pf textarea{flex:1;min-height:60px;resize:vertical;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
#pst{color:var(--mut);font-size:12px;padding:0 14px 8px}
</style></head><body>
<header><h1>Sessões</h1><input type="search" id="q" placeholder="Filtrar projeto ou sessão…">
<label><input type="checkbox" class="pf" value="claude" checked> Claude</label>
<label><input type="checkbox" class="pf" value="codex" checked> Codex</label>
<label><input type="checkbox" class="pf" value="antigravity" checked> Antigravity</label>
<button id="reload">Recarregar</button><span id="msg"></span></header>
<main id="list">Carregando…</main>
<aside id="panel"><div id="ph"><span id="ptag" class="tag"></span><b id="ptitle"></b>
<button id="papp">Abrir no app</button><button id="pclose">✕</button></div>
<div id="pm"></div><div id="pst"></div>
<form id="pf"><textarea id="ptext" placeholder="Mensagem… (Ctrl+Enter envia)"></textarea><button>Enviar</button></form></aside>
<script>
const NAMES={claude:"Claude Code",codex:"Codex",antigravity:"Antigravity"};let data=[];const open=new Set();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const fmt=d=>new Date(d).toLocaleString("pt-BR",{dateStyle:"short",timeStyle:"short"});
async function load(){data=await (await fetch("/api/sessions")).json();render()}
function render(){
  const q=document.getElementById("q").value.toLowerCase();
  const pf=[...document.querySelectorAll(".pf:checked")].map(e=>e.value);
  const groups={};
  for(const s of data){if(!pf.includes(s.provider))continue;
    if(q&&!(s.project+" "+s.title).toLowerCase().includes(q))continue;(groups[s.project]??=[]).push(s)}
  const projs=Object.entries(groups).map(([p,ss])=>[p,ss.sort((a,b)=>b.updated.localeCompare(a.updated))])
    .sort((a,b)=>b[1][0].updated.localeCompare(a[1][0].updated));
  document.getElementById("list").innerHTML=projs.map(([p,ss])=>{
    const name=p.split("\\").filter(Boolean).pop()||p;
    const counts=["claude","codex","antigravity"].map(k=>[k,ss.filter(s=>s.provider==k).length]).filter(x=>x[1]);
    return `<details data-p="${esc(p)}" ${open.has(p)||q?"open":""}><summary><b>${esc(name)}</b>
      ${counts.map(([k,n])=>`<span class="tag ${k}">${NAMES[k]} ${n}</span>`).join("")}
      <span class="path">${esc(p)}</span><span class="new">
      ${Object.keys(NAMES).map(k=>`<button data-new="${k}">+ ${NAMES[k]}</button>`).join(" ")}</span></summary>
      ${ss.map(s=>`<div class="row"><span class="tag ${s.provider}">${NAMES[s.provider]}</span>
        <span class="t" data-prov="${s.provider}" data-view="${esc(s.id)}" title="${esc(s.title)}">${esc(s.title)}</span><span class="d">${fmt(s.updated)}</span>
        <button data-prov="${s.provider}" data-id="${esc(s.id)}">Abrir</button></div>`).join("")}</details>`}).join("")||"Nada encontrado.";
}
async function post(body){const m=document.getElementById("msg");m.textContent="Abrindo…";
  const r=await (await fetch("/api/open",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})).json();
  m.textContent=r.ok?"Aberto ✓":"Erro: "+r.error}
let cur=null,timer=null,lastN=-1;
const $=id=>document.getElementById(id);
function view(prov,id){cur=data.find(s=>s.provider==prov&&s.id==id);lastN=-1;
  $("ptag").className="tag "+prov;$("ptag").textContent=NAMES[prov];$("ptitle").textContent=cur.title;
  $("pm").textContent="Carregando…";$("pf").style.display=prov=="antigravity"?"none":"flex";
  $("panel").classList.add("on");clearInterval(timer);poll();timer=setInterval(poll,3000)}
async function poll(){if(!cur)return;const c=cur;
  const r=await (await fetch(`/api/transcript?provider=${c.provider}&id=${encodeURIComponent(c.id)}`)).json();if(c!==cur)return;
  const pm=$("pm");$("pst").textContent=r.running?"Respondendo… (rodando no "+NAMES[c.provider]+")":r.error?"Erro: "+r.error:"";
  if(r.messages===null){pm.textContent="O Antigravity não deixa ler a conversa fora do app. Use “Abrir no app”.";return}
  if(r.messages.length===lastN)return;
  const atEnd=lastN<0||pm.scrollHeight-pm.scrollTop-pm.clientHeight<40;lastN=r.messages.length;
  pm.innerHTML=r.messages.map(m=>`<div class="m ${m.role}">${m.role=="tool"?"› ":""}${esc(m.text)}</div>`).join("")||"Sem mensagens.";
  if(atEnd)pm.scrollTop=pm.scrollHeight}
$("pclose").onclick=()=>{cur=null;clearInterval(timer);$("panel").classList.remove("on")};
$("papp").onclick=()=>cur&&post({provider:cur.provider,id:cur.id});
$("pf").onsubmit=async e=>{e.preventDefault();const t=$("ptext");if(!cur||!t.value.trim())return;
  const r=await (await fetch("/api/send",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({provider:cur.provider,id:cur.id,text:t.value})})).json();
  if(r.ok){t.value="";poll()}else $("pst").textContent="Erro: "+r.error};
$("ptext").onkeydown=e=>{if(e.key=="Enter"&&e.ctrlKey)$("pf").requestSubmit()};
document.addEventListener("click",e=>{const v=e.target.closest("[data-view]");if(v)return view(v.dataset.prov,v.dataset.view);
  const b=e.target.closest("button");if(!b||b.closest("#panel"))return;
  if(b.id==="reload")return load();const p=b.closest("details")?.dataset.p;
  if(b.dataset.new){e.preventDefault();post({provider:b.dataset.new,project:p})}
  else if(b.dataset.id)post({provider:b.dataset.prov,id:b.dataset.id})});
document.addEventListener("toggle",e=>{const p=e.target.dataset?.p;if(p)e.target.open?open.add(p):open.delete(p)},true);
document.getElementById("q").oninput=render;document.querySelectorAll(".pf").forEach(e=>e.onchange=render);load();
</script></body></html>"""

if __name__ == "__main__":
    print(f"Gerenciador em http://127.0.0.1:{PORT}")
    if "--no-browser" not in sys.argv:
        webbrowser.open(f"http://127.0.0.1:{PORT}")
    ThreadingHTTPServer.allow_reuse_address = False  # no Windows, reuse deixa 2 instâncias (versões velhas) na mesma porta
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
