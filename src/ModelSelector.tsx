import { useEffect, useRef, useState } from "react";
import { api, type Model, type Session, type Skill, type TurnOptions } from "./api";

export type AntigravityModelDef = {
  id: string;
  name: string;
  tier?: string;
  tag?: string;
};

export const ANTIGRAVITY_MODELS: AntigravityModelDef[] = [
  { id: "flash", name: "Gemini 3.8 Flash", tier: "Medium" },
  { id: "gemini-3-7-flash", name: "Gemini 3.7 Flash", tier: "Medium", tag: "Leaving Soon" },
  { id: "gemini-3-6-flash", name: "Gemini 3.6 Flash", tier: "Medium", tag: "Leaving Soon" },
  { id: "gemini-3-1-pro", name: "Gemini 3.1 Pro", tier: "Low", tag: "Leaving Soon" },
  { id: "pro", name: "Gemini 3.8 Pro", tier: "Thinking" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)", tag: "Notice" },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6 (Thinking)", tag: "Notice" },
  { id: "gpt-oss-120b", name: "GPT-OSS 120B (Medium)", tag: "Notice" },
];

// ponytail: lista fixa (aliases sempre apontam para a versão mais nova); a CLI 2.1.x não tem list_models
export const CLAUDE_MODELS = [
  { id: "opus", name: "Opus" },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];
/** "claude-opus-5-5" / "claude-haiku-4-5-20251001" -> "Opus 5.5" / "Haiku 4.5" */
export const prettyClaude = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? "." + m[3] : ""}` : id;
};
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function ModelSelector({
  session,
  options,
  onChange,
  disabled,
  notify,
  currentModel,
}: {
  session: Session;
  options: TurnOptions;
  onChange: (o: TurnOptions) => void;
  disabled?: boolean;
  notify?: (s: string) => void;
  currentModel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [codexModels, setCodexModels] = useState<Model[]>([]);
  const [codexSkills, setCodexSkills] = useState<Skill[]>([]);
  const [showSkills, setShowSkills] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fecha o popup ao clicar fora
  useEffect(() => {
    if (!open) return;
    const clickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", clickOutside);
    return () => window.removeEventListener("mousedown", clickOutside);
  }, [open]);

  // Se for Codex: carrega catálogo e estado da thread
  useEffect(() => {
    if (session.provider !== "codex") return;
    let active = true;
    api.catalog(session.project)
      .then((r) => {
        if (active) {
          setCodexModels(r.models || []);
          setCodexSkills((r.skills || []).flatMap((x) => x.skills).filter((s) => s.enabled));
        }
      })
      .catch((e) => active && notify?.(String(e)));
    return () => { active = false; };
  }, [session.provider, session.project]);

  useEffect(() => {
    if (session.provider !== "codex" || !session.id) return;
    let active = true;
    api.manage(session.id, "read")
      .then((r) => {
        if (active && r?.thread) {
          onChange({
            ...options,
            model: r.thread.model ?? options.model,
            effort: r.thread.reasoningEffort ?? options.effort,
          });
        }
      })
      .catch((e) => active && notify?.(String(e)));
    return () => { active = false; };
  }, [session.provider, session.id]);

  // Identifica o modelo ativo para o pill
  let pillName = "";
  let pillTier = "";
  if (session.provider === "antigravity") {
    const activeId = options.model || "flash";
    const found = ANTIGRAVITY_MODELS.find((m) => m.id === activeId);
    if (found) {
      pillName = found.name;
      pillTier = found.tier || "";
    } else {
      pillName = activeId;
    }
  } else if (session.provider === "claude") {
    pillName = CLAUDE_MODELS.find((m) => m.id === options.model)?.name ?? (currentModel ? prettyClaude(currentModel) : "Modelo padrão");
    pillTier = options.effort || "";
  } else if (session.provider === "codex") {
    const found = codexModels.find((m) => m.model === options.model);
    pillName = found ? found.displayName : (options.model || "Modelo padrão");
    pillTier = options.effort || "";
  }

  const selectedCodexModel = codexModels.find((m) => m.model === options.model);

  return (
    <div className="model-selector-wrap" ref={containerRef}>
      <button
        type="button"
        className={`model-pill-btn ${open ? "open" : ""}`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title="Selecionar modelo"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-pill-name">{pillName}</span>
        {pillTier && <span className="model-pill-tier">{pillTier}</span>}
        <svg className={`model-pill-arrow ${open ? "up" : "down"}`} width="9" height="9" viewBox="0 0 10 10">
          {open ? (
            <path d="M2.5 6.5L5 3.5L7.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          ) : (
            <path d="M2.5 3.5L5 6.5L7.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </svg>
      </button>

      {open && (
        <div className="model-popup" role="listbox">
          <div className="model-popup-head">Model</div>

          <div className="model-popup-list">
            {session.provider === "antigravity" &&
              ANTIGRAVITY_MODELS.map((m) => {
                const isSelected = (options.model || "flash") === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`model-option-row ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      onChange({ ...options, model: m.id });
                      setOpen(false);
                    }}
                  >
                    <div className="model-row-left">
                      <span className="model-name">{m.name}</span>
                      {m.tier && <span className="model-tier">{m.tier}</span>}
                    </div>
                    <div className="model-row-right">
                      {m.tag && (
                        <span className="model-tag">
                          {m.tag} <span className="tag-info">ⓘ</span>
                        </span>
                      )}
                      {isSelected && (
                        <svg className="model-check-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 8.5l3.5 3.5L13 4.5" />
                        </svg>
                      )}
                    </div>
                  </button>
                );
              })}

            {session.provider === "claude" && (
              <>
                {[{ id: "", name: "Modelo padrão da configuração" }, ...CLAUDE_MODELS].map((m) => {
                  const isSelected = (options.model ?? "") === m.id;
                  return (
                    <button
                      key={m.id || "default"}
                      type="button"
                      className={`model-option-row ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        onChange({ ...options, model: m.id || undefined });
                        setOpen(false);
                      }}
                    >
                      <div className="model-row-left">
                        <span className="model-name">{m.name}</span>
                      </div>
                      <div className="model-row-right">
                        {isSelected && (
                      <svg className="model-check-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 8.5l3.5 3.5L13 4.5" />
                      </svg>
                        )}
                      </div>
                    </button>
                  );
                })}
                <div className="model-section">
                  <div className="model-section-title">Esforço de raciocínio</div>
                  <div className="model-efforts">
                    {CLAUDE_EFFORTS.map((e) => (
                      <button
                        key={e}
                        type="button"
                        className={`effort-pill ${options.effort === e ? "selected" : ""}`}
                        onClick={() => onChange({ ...options, effort: options.effort === e ? undefined : e })}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {session.provider === "codex" && (
              <>
                <button
                  type="button"
                  className={`model-option-row ${!options.model ? "selected" : ""}`}
                  onClick={() => {
                    onChange({ ...options, model: undefined, effort: undefined });
                    setOpen(false);
                  }}
                >
                  <div className="model-row-left">
                    <span className="model-name">Modelo padrão da configuração</span>
                  </div>
                  <div className="model-row-right">
                    {!options.model && (
                      <svg className="model-check-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 8.5l3.5 3.5L13 4.5" />
                      </svg>
                    )}
                  </div>
                </button>

                {codexModels.map((m) => {
                  const isSelected = options.model === m.model;
                  return (
                    <button
                      key={m.model}
                      type="button"
                      className={`model-option-row ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        onChange({
                          ...options,
                          model: m.model,
                          effort: m.defaultReasoningEffort || undefined,
                        });
                        setOpen(false);
                      }}
                    >
                      <div className="model-row-left">
                        <span className="model-name">{m.displayName}</span>
                        {m.defaultReasoningEffort && <span className="model-tier">{m.defaultReasoningEffort}</span>}
                      </div>
                      <div className="model-row-right">
                        {isSelected && (
                          <svg className="model-check-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 8.5l3.5 3.5L13 4.5" />
                          </svg>
                        )}
                      </div>
                    </button>
                  );
                })}

                {/* Seletor de reasoning effort */}
                {selectedCodexModel && selectedCodexModel.supportedReasoningEfforts?.length > 0 && (
                  <div className="model-section">
                    <div className="model-section-title">Esforço de raciocínio</div>
                    <div className="model-efforts">
                      {selectedCodexModel.supportedReasoningEfforts.map((eff) => (
                        <button
                          key={eff.reasoningEffort}
                          type="button"
                          className={`effort-pill ${options.effort === eff.reasoningEffort ? "selected" : ""}`}
                          onClick={() => onChange({ ...options, effort: eff.reasoningEffort })}
                        >
                          {eff.reasoningEffort}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Skills */}
                {codexSkills.length > 0 && (
                  <div className="model-section">
                    <button
                      type="button"
                      className="skills-toggle-btn"
                      onClick={() => setShowSkills(!showSkills)}
                    >
                      <span>Skills ({options.skills?.length ?? 0} ativas)</span>
                      <span className="skills-toggle-icon">{showSkills ? "−" : "+"}</span>
                    </button>
                    {showSkills && (
                      <div className="skills-inline-list">
                        {codexSkills.map((s) => {
                          const checked = options.skills?.some((x) => x.path === s.path) ?? false;
                          return (
                            <label key={s.path} className="skill-item" title={s.description}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  const nextSkills = e.target.checked
                                    ? [...(options.skills ?? []), { name: s.name, path: s.path }]
                                    : (options.skills ?? []).filter((x) => x.path !== s.path);
                                  onChange({ ...options, skills: nextSkills });
                                }}
                              />
                              <span>{s.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
