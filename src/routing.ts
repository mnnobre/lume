// Roteador: escolhe provider/modelo/esforço de cada tarefa por regras e pela cota de cada plano.
// Sem IA no meio ("o modelo extrai, o código decide"); sem imports de runtime para o teste rodar em Node.
import type { Provider, UsageReport } from "./api";

export type Level = "leve" | "medio" | "pesado";
export type Target = { provider: Provider; model: string; effort: string; account?: string }; // account: conta extra do Claude Code
type Dest = { provider: Provider; account?: string };
/** Identifica provider + conta (a passagem não volta para quem já pegou a tarefa). */
export const destKey = (d: Dest) => `${d.provider}:${d.account ?? ""}`;

export type RouterConfig = {
  providers: Record<Provider, { enabled: boolean; ceiling: number; weeklyCeiling: number }>; // tetos em % da cota
  levels: Record<Level, Target[]>; // ordem de preferência
  rules: {
    leveMaxChars: number; // até isso, sem arquivo citado e sem palavra pesada = leve
    pesadoMinChars: number; // a partir disso = pesado
    pesadoMinFiles: number; // arquivos citados a partir disso = pesado
    leveWords: string[];
    pesadoWords: string[];
    defaultLevel: Level;
  };
  confirm: boolean; // mostra a decisão e espera o clique antes de enviar
  rotateAccounts: boolean; // conta do Claude no teto: tenta o mesmo modelo nas outras contas antes de mudar de provider
  handoff: { auto: boolean; messages: number; note: string };
};

export const LEVELS: [Level, string][] = [["leve", "Leve"], ["medio", "Médio"], ["pesado", "Pesado"]];

// Pesos iniciais a partir do LLM Benchmark v4 (akitaonrails.com, set/2026): o nível A é intercambiável no dia a dia;
// Gemini 3.8 Flash no Antigravity é nível A sem custo extra (assinatura), então pega o leve; o Claude fica com o pesado.
export const DEFAULT_CONFIG: RouterConfig = {
  providers: {
    claude: { enabled: true, ceiling: 85, weeklyCeiling: 90 },
    codex: { enabled: true, ceiling: 90, weeklyCeiling: 95 },
    antigravity: { enabled: true, ceiling: 90, weeklyCeiling: 95 },
  },
  levels: {
    leve: [
      { provider: "antigravity", model: "flash", effort: "low" },
      { provider: "codex", model: "", effort: "low" },
      { provider: "claude", model: "haiku", effort: "low" },
    ],
    medio: [
      { provider: "codex", model: "", effort: "medium" },
      { provider: "claude", model: "sonnet", effort: "medium" },
      { provider: "antigravity", model: "flash", effort: "high" },
    ],
    pesado: [
      { provider: "claude", model: "opus", effort: "high" },
      { provider: "codex", model: "", effort: "high" },
      { provider: "antigravity", model: "pro", effort: "thinking" },
    ],
  },
  rules: {
    leveMaxChars: 80,
    pesadoMinChars: 600,
    pesadoMinFiles: 3,
    leveWords: ["oi", "olá", "obrigado", "valeu", "explica", "o que é", "renomeia", "cor", "texto", "typo", "commit"],
    pesadoWords: ["refatora", "arquitetura", "investiga", "migra", "redesenha", "do zero", "performance", "segurança", "por que", "não sei por quê", "intermitente"],
    defaultLevel: "medio",
  },
  confirm: true,
  rotateAccounts: true,
  handoff: {
    auto: false,
    messages: 6,
    note: "Continue de onde a tarefa parou. Antes de mexer, rode `git status` e `git diff` para ver o que já foi alterado.",
  },
};

/** Junta a config salva com os padrões (campos novos de versões futuras não somem). */
export function withDefaults(saved: Partial<RouterConfig> | null | undefined): RouterConfig {
  const d = DEFAULT_CONFIG;
  if (!saved) return structuredClone(d);
  return {
    ...d,
    ...saved,
    providers: { ...d.providers, ...saved.providers },
    levels: { ...d.levels, ...saved.levels },
    rules: { ...d.rules, ...saved.rules },
    handoff: { ...d.handoff, ...saved.handoff },
  };
}

const FILE_RE = /[\w.\-/\\]+\.(tsx?|jsx?|rs|py|css|scss|html|json|md|toml|ya?ml|cs|java|go|rb|php|sql|kt|swift)\b/gi;
const has = (text: string, words: string[]) => words.find((w) => w.trim() && new RegExp(`(^|[^\\p{L}])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu").test(text));

export function classify(text: string, cfg: RouterConfig): { level: Level; reason: string } {
  const r = cfg.rules;
  const t = text.trim();
  const files = new Set(t.match(FILE_RE) ?? []).size;
  const heavy = has(t, r.pesadoWords);
  if (heavy) return { level: "pesado", reason: `menciona "${heavy}"` };
  if (files >= r.pesadoMinFiles) return { level: "pesado", reason: `cita ${files} arquivos` };
  if (t.length >= r.pesadoMinChars) return { level: "pesado", reason: `pedido longo (${t.length} caracteres)` };
  if (!files && t.length <= r.leveMaxChars) return { level: "leve", reason: "pedido curto, sem arquivo citado" };
  const light = has(t, r.leveWords);
  if (light && !files) return { level: "leve", reason: `menciona "${light}"` };
  return { level: r.defaultLevel, reason: files ? `cita ${files} arquivo(s)` : "pedido comum" };
}

/** % usado: janela curta (5 h / sessão) e semanal; null = sem leitura. */
export function quota(usage: UsageReport[] | null, d: Dest): { short: number | null; weekly: number | null } {
  const r = usage?.find((u) => u.provider === d.provider && (u.account ?? undefined) === (d.account || undefined));
  const weekly = r?.windows.find((w) => /seman/i.test(w.label));
  const short = r?.windows.find((w) => !/seman/i.test(w.label));
  return { short: short?.used ?? null, weekly: weekly?.used ?? null };
}

export function overCeiling(usage: UsageReport[] | null, d: Dest, cfg: RouterConfig): string | null {
  const q = quota(usage, d);
  const c = cfg.providers[d.provider];
  if (q.short != null && q.short >= c.ceiling) return `cota de 5 h em ${Math.round(q.short)}% (teto ${c.ceiling}%)`;
  if (q.weekly != null && q.weekly >= c.weeklyCeiling) return `cota semanal em ${Math.round(q.weekly)}% (teto ${c.weeklyCeiling}%)`;
  return null;
}

export type Route = { level: Level; reason: string; target: Target | null; skipped: { target: Target; why: string }[] };
export type AccountsMap = Partial<Record<Provider, (string | undefined)[]>>;

/** Primeiro da lista do nível que está ligado e abaixo do teto; `exclude` = destKey de quem já pegou esta tarefa. */
export function route(
  text: string,
  cfg: RouterConfig,
  usage: UsageReport[] | null,
  level?: Level,
  exclude: string[] = [],
  accounts: (string | undefined)[] | AccountsMap = [],
): Route {
  const c = level ? { level, reason: "nível escolhido por você" } : classify(text, cfg);
  const skipped: Route["skipped"] = [];
  const seen = new Set<string>();

  const getAccounts = (provider: Provider): (string | undefined)[] => {
    if (Array.isArray(accounts)) {
      return provider === "claude" ? accounts : [];
    }
    return accounts[provider] ?? [];
  };

  // cada alvo seguido do mesmo modelo nas outras contas configuradas (accounts: undefined = principal)
  const candidates = cfg.levels[c.level].flatMap((t) => {
    const accs = getAccounts(t.provider);
    return (t.provider === "claude" || t.provider === "antigravity") && cfg.rotateAccounts && accs.length > 0
      ? [t, ...accs.filter((a) => a !== t.account).map((account) => ({ ...t, account }))]
      : [t];
  }).filter((t) => !seen.has(destKey(t)) && !!seen.add(destKey(t)));

  for (const target of candidates) {
    const why = !cfg.providers[target.provider].enabled ? "provider desligado" : exclude.includes(destKey(target)) ? "já pegou esta tarefa" : overCeiling(usage, target, cfg);
    if (!why) return { ...c, target, skipped };
    skipped.push({ target, why });
  }
  return { ...c, target: null, skipped };
}

/** Mensagem que abre a conversa no próximo provider quando a cota do atual estoura. */
export function handoffText(from: string, why: string, request: string, recent: { role: string; text: string }[], cfg: RouterConfig) {
  const lines = recent
    .filter((m) => m.role !== "tool" && m.text.trim())
    .slice(-cfg.handoff.messages)
    .map((m) => `${m.role === "user" ? "Usuário" : "Agente"}: ${m.text.trim().slice(0, 1200)}`);
  return [
    `Esta tarefa começou em outro agente (${from}) e foi passada para você: ${why}.`,
    "",
    "Pedido original:",
    request.trim(),
    ...(lines.length ? ["", "Últimas mensagens:", ...lines] : []),
    "",
    cfg.handoff.note,
  ].join("\n");
}
