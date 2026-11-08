import { useEffect, useState } from "react";
import { api, type Account, type Provider } from "./api";

// Caches separados para Claude Code e Antigravity
let claudeCache: Account[] | null = null;
const claudeSubs = new Set<(a: Account[]) => void>();

let agyCache: Account[] | null = null;
const agySubs = new Set<(a: Account[]) => void>();

export function reloadClaudeAccounts() {
  return api.claudeAccounts().then((a) => {
    claudeCache = a;
    claudeSubs.forEach((f) => f(a));
    return a;
  });
}

export function reloadAntigravityAccounts() {
  return api.antigravityAccounts().then((a) => {
    agyCache = a;
    agySubs.forEach((f) => f(a));
    return a;
  });
}

export function reloadAccounts(provider?: Provider) {
  if (provider === "antigravity") {
    return reloadAntigravityAccounts();
  }
  if (provider === "claude") {
    return reloadClaudeAccounts();
  }
  return Promise.all([reloadClaudeAccounts(), reloadAntigravityAccounts()]).then(([c]) => c);
}

export function useClaudeAccounts() {
  const [accounts, setAccounts] = useState<Account[]>(claudeCache ?? []);
  useEffect(() => {
    claudeSubs.add(setAccounts);
    if (!claudeCache) reloadClaudeAccounts().catch(() => {});
    return () => void claudeSubs.delete(setAccounts);
  }, []);
  return accounts;
}

export function useAntigravityAccounts() {
  const [accounts, setAccounts] = useState<Account[]>(agyCache ?? []);
  useEffect(() => {
    agySubs.add(setAccounts);
    if (!agyCache) reloadAntigravityAccounts().catch(() => {});
    return () => void agySubs.delete(setAccounts);
  }, []);
  return accounts;
}

export function useAccounts(provider: Provider): Account[] {
  const claude = useClaudeAccounts();
  const agy = useAntigravityAccounts();
  if (provider === "antigravity") return agy;
  if (provider === "claude") return claude;
  return [];
}

/** "Principal" para a conta padrão, o nome da pasta para as extras. */
export const accountName = (name?: string | null) => name ?? "Principal";
