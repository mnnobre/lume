import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, type AggregatedSkill } from "./api";
import { ProviderIcon } from "./ProviderIcon";
import {
  originBadgeClass,
  originLabel,
  SkillLocationPopover,
} from "./SkillPopover";

type ScopeFilter = "all" | "global" | "project";
type ProviderFilter = "all" | "claude" | "antigravity" | "codex";
type OriginFilter = "all" | "builtin" | "plugin" | "user";

export function SkillsView({
  projects,
  notify,
}: {
  projects: { path: string }[];
  notify: (m: string) => void;
}) {
  const [skills, setSkills] = useState<AggregatedSkill[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [multiOnly, setMultiOnly] = useState(false);
  const [displayMode, setDisplayMode] = useState<"card" | "list">(() => {
    return (localStorage.getItem("lume.skills.displayMode") as "card" | "list") || "card";
  });

  const changeDisplayMode = (mode: "card" | "list") => {
    setDisplayMode(mode);
    localStorage.setItem("lume.skills.displayMode", mode);
  };

  // Modal para pré-visualização de SKILL.md
  const [previewSkill, setPreviewSkill] = useState<{
    name: string;
    path: string;
    content: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const projectPaths = useMemo(() => projects.map((p) => p.path), [projects]);

  const loadSkills = async () => {
    setLoading(true);
    try {
      const list = await api.listAllSkills(projectPaths);
      setSkills(list);
    } catch (err) {
      notify(`Erro ao carregar skills: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSkills();
  }, [projectPaths.join(";")]);

  const openFolder = async (path: string) => {
    try {
      await api.openSkillPath(path);
    } catch (err) {
      notify(`Não foi possível abrir a pasta: ${String(err)}`);
    }
  };

  const preview = async (skill: AggregatedSkill) => {
    const loc = skill.locations[0];
    if (!loc) return;
    setPreviewLoading(true);
    setPreviewSkill({ name: skill.name, path: loc.skill_path, content: "" });
    try {
      const content = await api.readSkillContent(loc.skill_path);
      setPreviewSkill({ name: skill.name, path: loc.skill_path, content });
    } catch (err) {
      notify(`Não foi possível ler SKILL.md: ${String(err)}`);
      setPreviewSkill(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Filtragem
  const filtered = useMemo(() => {
    if (!skills) return [];
    const q = query.trim().toLowerCase();

    return skills.filter((skill) => {
      // Filtro de texto (nome, descrição, caminhos, nomes de projeto)
      if (q) {
        const matchesName = skill.name.toLowerCase().includes(q);
        const matchesDesc = skill.description.toLowerCase().includes(q);
        const matchesLoc = skill.locations.some(
          (loc) =>
            (loc.project_name?.toLowerCase().includes(q) ?? false) ||
            loc.skill_path.toLowerCase().includes(q) ||
            loc.provider.toLowerCase().includes(q)
        );
        if (!matchesName && !matchesDesc && !matchesLoc) return false;
      }

      // Filtro por Provider
      if (providerFilter !== "all") {
        const hasProvider = skill.locations.some(
          (loc) => loc.provider === providerFilter
        );
        if (!hasProvider) return false;
      }

      // Filtro por Origem (Nativa / Plugin / Usuário)
      if (originFilter !== "all") {
        if (!skill.origins?.includes(originFilter)) return false;
      }

      // Filtro por Escopo
      if (scopeFilter !== "all") {
        const hasScope = skill.locations.some(
          (loc) => loc.scope === scopeFilter
        );
        if (!hasScope) return false;
      }

      // Filtro apenas presentes em múltiplos locais
      if (multiOnly && skill.locations.length < 2) {
        return false;
      }

      return true;
    });
  }, [skills, query, providerFilter, originFilter, scopeFilter, multiOnly]);

  // Estatísticas
  const stats = useMemo(() => {
    if (!skills) {
      return {
        total: 0,
        builtinCount: 0,
        pluginCount: 0,
        userCount: 0,
        projectCount: 0,
        globalCount: 0,
        multiCount: 0,
        claude: 0,
        agy: 0,
        codex: 0,
      };
    }

    let builtinCount = 0;
    let pluginCount = 0;
    let userCount = 0;
    let projectCount = 0;
    let globalCount = 0;
    let multiCount = 0;
    let claude = 0;
    let agy = 0;
    let codex = 0;

    for (const s of skills) {
      if (s.origins?.includes("builtin")) builtinCount++;
      if (s.origins?.includes("plugin")) pluginCount++;
      if (s.origins?.includes("user")) userCount++;
      if (s.locations.some((l) => l.scope === "project")) projectCount++;
      if (s.locations.some((l) => l.scope === "global")) globalCount++;
      if (s.locations.length > 1) multiCount++;
      if (s.locations.some((l) => l.provider === "claude")) claude++;
      if (s.locations.some((l) => l.provider === "antigravity")) agy++;
      if (s.locations.some((l) => l.provider === "codex")) codex++;
    }

    return {
      total: skills.length,
      builtinCount,
      pluginCount,
      userCount,
      projectCount,
      globalCount,
      multiCount,
      claude,
      agy,
      codex,
    };
  }, [skills]);

  return (
    <section className="skills-view">
      <div className="drag-strip" data-drag />

      <header className="content-head" data-drag>
        <div>
          <div className="skills-head-title">
            <h1>Skills</h1>
            <button
              type="button"
              className="icon-btn small refresh-skills"
              onClick={loadSkills}
              title="Recarregar skills"
              aria-label="Recarregar skills"
            >
              <svg
                className={loading ? "spin" : ""}
                width="14"
                height="14"
                viewBox="0 0 16 16"
              >
                <path
                  d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          <p className="sub">
            Visão unificada das skills no Claude Code, Antigravity e Codex, identificando se são nativas do harness, plugins ou criadas por você.
          </p>
        </div>

        <div className="filters skills-filters">
          <div className="search skills-search">
            <svg width="13" height="13" viewBox="0 0 16 16">
              <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar skill ou projeto…"
            />
            {query && (
              <button
                type="button"
                className="clear-query"
                onClick={() => setQuery("")}
                title="Limpar busca"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="skills-body">
        {/* Métricas / Visão rápida */}
        <div className="dash-tiles skills-tiles">
          <div className="dash-tile">
            <span className="dash-num">{stats.total}</span>
            <span className="dash-label">Skills únicas</span>
          </div>
          <div className="dash-tile">
            <span className="dash-num origin-num-builtin">{stats.builtinCount}</span>
            <span className="dash-label">Nativas (Harness)</span>
          </div>
          <div className="dash-tile">
            <span className="dash-num origin-num-plugin">{stats.pluginCount}</span>
            <span className="dash-label">Plugins & Extensões</span>
          </div>
          <div className="dash-tile">
            <span className="dash-num origin-num-user">{stats.userCount}</span>
            <span className="dash-label">Criadas pelo Usuário / IA</span>
          </div>
        </div>

        {/* Barra de Filtros Refinados */}
        <div className="skills-bar">
          <div className="skills-chips-group">
            {/* Origem */}
            <div className="skills-chips">
              <span className="skills-filter-label">Origem:</span>
              <button
                type="button"
                className={`chip ${originFilter === "all" ? "on" : ""}`}
                onClick={() => setOriginFilter("all")}
              >
                Todas
              </button>
              <button
                type="button"
                className={`chip origin-chip-builtin ${originFilter === "builtin" ? "on" : ""}`}
                onClick={() => setOriginFilter(originFilter === "builtin" ? "all" : "builtin")}
                title="Skills que vieram de fábrica com o Claude, Antigravity ou Codex"
              >
                Nativas ({stats.builtinCount})
              </button>
              <button
                type="button"
                className={`chip origin-chip-plugin ${originFilter === "plugin" ? "on" : ""}`}
                onClick={() => setOriginFilter(originFilter === "plugin" ? "all" : "plugin")}
                title="Skills de plugins e pacotes instalados"
              >
                Plugins ({stats.pluginCount})
              </button>
              <button
                type="button"
                className={`chip origin-chip-user ${originFilter === "user" ? "on" : ""}`}
                onClick={() => setOriginFilter(originFilter === "user" ? "all" : "user")}
                title="Skills criadas por você ou pela IA nos projetos e pastas locais"
              >
                Usuário / IA ({stats.userCount})
              </button>
            </div>

            {/* Ferramenta */}
            <div className="skills-chips">
              <span className="skills-filter-label">Ferramenta:</span>
              <button
                type="button"
                className={`chip ${providerFilter === "all" ? "on" : ""}`}
                onClick={() => setProviderFilter("all")}
              >
                Todas
              </button>
              <button
                type="button"
                className={`chip claude ${providerFilter === "claude" ? "on" : ""}`}
                onClick={() => setProviderFilter(providerFilter === "claude" ? "all" : "claude")}
              >
                <ProviderIcon p="claude" /> Claude ({stats.claude})
              </button>
              <button
                type="button"
                className={`chip antigravity ${providerFilter === "antigravity" ? "on" : ""}`}
                onClick={() => setProviderFilter(providerFilter === "antigravity" ? "all" : "antigravity")}
              >
                <ProviderIcon p="antigravity" /> Antigravity ({stats.agy})
              </button>
              <button
                type="button"
                className={`chip codex ${providerFilter === "codex" ? "on" : ""}`}
                onClick={() => setProviderFilter(providerFilter === "codex" ? "all" : "codex")}
              >
                <ProviderIcon p="codex" /> Codex ({stats.codex})
              </button>
            </div>

            {/* Escopo */}
            <div className="skills-chips">
              <span className="skills-filter-label">Escopo:</span>
              <button
                type="button"
                className={`chip ${scopeFilter === "all" ? "on" : ""}`}
                onClick={() => setScopeFilter("all")}
              >
                Todos
              </button>
              <button
                type="button"
                className={`chip ${scopeFilter === "project" ? "on" : ""}`}
                onClick={() => setScopeFilter(scopeFilter === "project" ? "all" : "project")}
              >
                Projetos ({stats.projectCount})
              </button>
              <button
                type="button"
                className={`chip ${scopeFilter === "global" ? "on" : ""}`}
                onClick={() => setScopeFilter(scopeFilter === "global" ? "all" : "global")}
              >
                Globais ({stats.globalCount})
              </button>
              <button
                type="button"
                className={`chip ${multiOnly ? "on" : ""}`}
                onClick={() => setMultiOnly(!multiOnly)}
                title="Mostrar apenas skills presentes em 2 ou mais locais"
              >
                Em 2+ locais ({stats.multiCount})
              </button>
            </div>
          </div>

          {/* Alternador de Modo: Cards vs Lista */}
          <div className="skills-view-toggle">
            <button
              type="button"
              className={`toggle-mode-btn ${displayMode === "card" ? "active" : ""}`}
              onClick={() => changeDisplayMode("card")}
              title="Modo Cards"
              aria-label="Modo Cards"
            >
              <svg width="13" height="13" viewBox="0 0 16 16">
                <rect x="2" y="2" width="5.2" height="5.2" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <rect x="8.8" y="2" width="5.2" height="5.2" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <rect x="2" y="8.8" width="5.2" height="5.2" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <rect x="8.8" y="8.8" width="5.2" height="5.2" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
              </svg>
              <span>Cards</span>
            </button>
            <button
              type="button"
              className={`toggle-mode-btn ${displayMode === "list" ? "active" : ""}`}
              onClick={() => changeDisplayMode("list")}
              title="Modo Lista"
              aria-label="Modo Lista"
            >
              <svg width="13" height="13" viewBox="0 0 16 16">
                <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              <span>Lista</span>
            </button>
          </div>
        </div>

        {/* Lista de Skills */}
        <div className={`skills-list ${displayMode}`}>
          {loading && !skills && (
            <p className="hint">Buscando skills em ferramentas e projetos…</p>
          )}

          {!loading && skills && filtered.length === 0 && (
            <div className="skills-empty">
              <p className="hint">Nenhuma skill encontrada com os filtros selecionados.</p>
              {(query || providerFilter !== "all" || originFilter !== "all" || scopeFilter !== "all" || multiOnly) && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setQuery("");
                    setProviderFilter("all");
                    setOriginFilter("all");
                    setScopeFilter("all");
                    setMultiOnly(false);
                  }}
                >
                  Limpar filtros
                </button>
              )}
            </div>
          )}

          {displayMode === "card"
            ? filtered.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  openFolder={openFolder}
                  onPreview={() => preview(skill)}
                />
              ))
            : filtered.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  openFolder={openFolder}
                  onPreview={() => preview(skill)}
                />
              ))}
        </div>
      </div>

      {/* Modal de Pré-visualização de SKILL.md */}
      {previewSkill && (
        <div className="skills-modal-backdrop" onClick={() => setPreviewSkill(null)}>
          <div
            className="skills-modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="skills-modal-head">
              <div>
                <h2>{previewSkill.name}</h2>
                <span className="skills-modal-path">{previewSkill.path}</span>
              </div>
              <div className="skills-modal-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => openFolder(previewSkill.path)}
                >
                  Abrir pasta
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setPreviewSkill(null)}
                  title="Fechar"
                >
                  ×
                </button>
              </div>
            </div>

            <div className="skills-modal-body">
              {previewLoading ? (
                <p className="hint">Carregando conteúdo de SKILL.md…</p>
              ) : previewSkill.content ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {previewSkill.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <p className="hint">Arquivo vazio ou sem descrição disponível.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SkillCard({
  skill,
  openFolder,
  onPreview,
}: {
  skill: AggregatedSkill;
  openFolder: (path: string) => void;
  onPreview: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = skill.description.length > 220;

  return (
    <div className="skill-card">
      <div className="skill-card-top">
        <div className="skill-card-header">
          <div className="skill-card-name-group">
            <h3 className="skill-card-name" title={skill.name}>
              {skill.name}
            </h3>
            {skill.origins?.map((orig) => (
              <span
                key={orig}
                className={`origin-badge ${originBadgeClass(orig)}`}
                title={`Origem: ${originLabel(orig)}`}
              >
                {originLabel(orig)}
              </span>
            ))}
            <span
              className={`skill-loc-badge ${skill.locations.length > 1 ? "multiple" : ""}`}
              title={`${skill.locations.length} local(is) de uso`}
            >
              {skill.locations.length} {skill.locations.length === 1 ? "local" : "locais"}
            </span>
          </div>

          <div className="skill-card-actions">
            <button
              type="button"
              className="btn small"
              onClick={onPreview}
              title="Ver documentação e instruções (SKILL.md)"
            >
              Ver SKILL.md
            </button>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => openFolder(skill.locations[0].skill_path)}
              title="Abrir pasta no Explorer"
            >
              <svg width="13" height="13" viewBox="0 0 16 16">
                <path
                  d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
              </svg>
            </button>
          </div>
        </div>

        {skill.description ? (
          <div className="skill-card-desc">
            <p>
              {isLong && !expanded
                ? `${skill.description.slice(0, 220)}…`
                : skill.description}
            </p>
            {isLong && (
              <button
                type="button"
                className="skill-toggle-desc"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "Mostrar menos" : "Mostrar mais"}
              </button>
            )}
          </div>
        ) : (
          <p className="skill-card-desc empty">Sem descrição detalhada.</p>
        )}
      </div>

      {/* Seção de Tags com Popover inteligente de overflow */}
      <div className="skill-card-footer">
        <span className="skill-footer-label">Onde está:</span>
        <SkillLocationPopover
          locations={skill.locations}
          skillName={skill.name}
          openFolder={openFolder}
          maxVisible={3}
        />
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  openFolder,
  onPreview,
}: {
  skill: AggregatedSkill;
  openFolder: (path: string) => void;
  onPreview: () => void;
}) {
  return (
    <div className="skill-row">
      <div className="skill-row-main">
        <div className="skill-row-name-group">
          <span className="skill-row-name" title={skill.name}>
            {skill.name}
          </span>
          {skill.origins?.map((orig) => (
            <span
              key={orig}
              className={`origin-badge ${originBadgeClass(orig)}`}
              title={`Origem: ${originLabel(orig)}`}
            >
              {originLabel(orig)}
            </span>
          ))}
          <span
            className={`skill-loc-badge ${skill.locations.length > 1 ? "multiple" : ""}`}
            title={`${skill.locations.length} local(is) de uso`}
          >
            {skill.locations.length} {skill.locations.length === 1 ? "local" : "locais"}
          </span>
        </div>
        {skill.description ? (
          <p className="skill-row-desc" title={skill.description}>
            {skill.description}
          </p>
        ) : (
          <p className="skill-row-desc empty">Sem descrição detalhada.</p>
        )}
      </div>

      <div className="skill-row-tags">
        <SkillLocationPopover
          locations={skill.locations}
          skillName={skill.name}
          openFolder={openFolder}
          maxVisible={2}
        />
      </div>

      <div className="skill-row-actions">
        <button
          type="button"
          className="btn small"
          onClick={onPreview}
          title="Ver documentação e instruções (SKILL.md)"
        >
          Ver SKILL.md
        </button>
        <button
          type="button"
          className="icon-btn small"
          onClick={() => openFolder(skill.locations[0].skill_path)}
          title="Abrir pasta no Explorer"
        >
          <svg width="13" height="13" viewBox="0 0 16 16">
            <path
              d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
