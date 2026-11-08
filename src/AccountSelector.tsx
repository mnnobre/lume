import { useEffect, useRef, useState } from "react";
import { api, type Account, type Session } from "./api";
import { accountName, reloadAccounts, useClaudeAccounts, useAntigravityAccounts } from "./accounts";
import { heat, primaryWindow, useUsage } from "./usage";

const initial = (a: Account) => accountName(a.name)[0].toUpperCase();

/**
 * Conta da conversa (Claude Code ou Antigravity), ao lado do seletor de modelo.
 * Só aparece com mais de uma conta no provider da conversa.
 * Rascunho: troca na hora.
 * Conversa em andamento:
 * - Claude: move o histórico para a outra conta (com confirmação).
 * - Antigravity: somente leitura (conversas pertencem à conta em que foram criadas).
 */
export function AccountSelector({ session, busy, onChange, notify }: {
  session: Session;
  busy: boolean;
  onChange: (s: Session) => void;
  notify: (m: string) => void;
}) {
  const claudeAccounts = useClaudeAccounts();
  const agyAccounts = useAntigravityAccounts();
  const accounts = session.provider === "antigravity" ? agyAccounts : claudeAccounts;

  const { data: usage } = useUsage();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<Account | null>(null);
  const [moving, setMoving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return setConfirm(null);
    reloadAccounts(session.provider).catch(() => {});
    const out = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", out);
    return () => window.removeEventListener("mousedown", out);
  }, [open, session.provider]);

  if ((session.provider !== "claude" && session.provider !== "antigravity") || accounts.length < 2) return null;

  const current = accounts.find((a) => (a.name ?? undefined) === session.account) ?? accounts[0];
  const isAgy = session.provider === "antigravity";
  const isExisting = !!session.id;

  const used = (a: Account) => {
    const r = usage?.find((u) => u.provider === session.provider && (u.account ?? null) === a.name);
    return r ? primaryWindow(r)?.used ?? null : null;
  };

  const loginAccount = (name: string | null) => {
    if (isAgy) {
      api.loginAntigravityAccount(name).catch((er) => notify(String(er)));
    } else {
      api.loginClaudeAccount(name).catch((er) => notify(String(er)));
    }
  };

  const choose = async (a: Account) => {
    if (!a.logged_in) return;
    if (a === current) return setOpen(false);
    if (!session.id) {
      onChange({ ...session, account: a.name ?? undefined });
      return setOpen(false);
    }
    if (isAgy) {
      notify("Conversas do Antigravity pertencem à conta em que foram criadas.");
      return;
    }
    setConfirm(a);
  };

  const move = async () => {
    if (!confirm || isAgy) return;
    setMoving(true);
    try {
      const s = await api.moveClaudeAccount(session.id, confirm.name);
      onChange(s);
      notify(`Conversa movida para a conta ${accountName(confirm.name)}. A próxima mensagem já usa a cota dela.`);
      setOpen(false);
    } catch (e) {
      notify(String(e));
    } finally {
      setMoving(false);
    }
  };

  const providerLabel = isAgy ? "Antigravity" : "Claude";

  return (
    <div className="model-selector-wrap account-selector" ref={ref}>
      <button
        type="button"
        className={`model-pill-btn ${open ? "open" : ""}`}
        onClick={() => setOpen(!open)}
        title={`Conta do ${providerLabel}: ${accountName(current.name)}${current.email ? ` (${current.email})` : ""}${isExisting && isAgy ? " · Conversas do Antigravity pertencem à conta em que foram criadas" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="account-avatar">{initial(current)}</span>
        <span className="model-pill-name">{accountName(current.name)}</span>
        <svg className={`model-pill-arrow ${open ? "up" : "down"}`} width="9" height="9" viewBox="0 0 10 10">
          <path d={open ? "M2.5 6.5L5 3.5L7.5 6.5" : "M2.5 3.5L5 6.5L7.5 3.5"} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="model-popup account-popup" role="listbox">
          {confirm ? (
            <div className="account-confirm">
              <b>Mover para a conta {accountName(confirm.name)}?</b>
              <p>O histórico vai junto e a conversa continua de onde parou. A próxima mensagem já usa a cota dessa conta.</p>
              {busy && <p className="usage-error">Espere o turno terminar para trocar de conta.</p>}
              <div className="account-confirm-actions">
                <button className="btn small" onClick={() => setConfirm(null)}>Voltar</button>
                <button className="btn small primary" disabled={busy || moving} onClick={move}>{moving ? "Movendo…" : "Mover conversa"}</button>
              </div>
            </div>
          ) : (
            <>
              <div className="model-popup-head">{session.id ? `Conta desta conversa (${providerLabel})` : `Conta (${providerLabel})`}</div>
              <div className="model-popup-list">
                {accounts.map((a) => {
                  const pct = used(a);
                  const selected = a === current;
                  const disabled = !a.logged_in || (isExisting && isAgy && !selected);
                  return (
                    <button
                      key={a.name ?? ""}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-disabled={disabled}
                      className={`model-option-row ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`}
                      onClick={() => choose(a)}
                    >
                      <div className="model-row-left account-row">
                        <span className="account-avatar">{initial(a)}</span>
                        <span className="account-text">
                          <span className="model-name">
                            {accountName(a.name)}
                            {a.plan && <span className="model-tier"> · {a.plan[0].toUpperCase() + a.plan.slice(1)}</span>}
                          </span>
                          <span className="model-tier">{a.logged_in ? a.email ?? "Logada" : "Sem login"}</span>
                        </span>
                      </div>
                      <div className="model-row-right">
                        {pct != null && <span className={`usage-pct ${heat(pct)}`} title="Uso da janela">{Math.round(pct)}%</span>}
                        {!a.logged_in && (
                          <span className="link" onClick={(e) => { e.stopPropagation(); loginAccount(a.name); }}>
                            Entrar
                          </span>
                        )}
                        {selected && (
                          <svg className="model-check-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.5 3.5L13 4.5" /></svg>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
              {session.id && (
                <p className="account-hint">
                  {isAgy
                    ? "Conversas do Antigravity pertencem à conta em que foram criadas."
                    : "Trocar move a conversa para a outra conta, com o histórico."}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
