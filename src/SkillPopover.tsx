import React, { useEffect, useRef, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";
import { type Provider, type SkillLocation } from "./api";

function providerColor(p: string): string {
  if (p === "claude") return "var(--claude)";
  if (p === "antigravity") return "var(--antigravity)";
  if (p === "codex") return "var(--codex)";
  return "var(--accent)";
}

function providerLabel(p: string): string {
  if (p === "claude") return "Claude";
  if (p === "antigravity") return "Antigravity";
  if (p === "codex") return "Codex";
  return "Geral";
}

export function originLabel(o: string): string {
  if (o === "builtin") return "Nativa";
  if (o === "plugin") return "Plugin";
  return "Usuário / IA";
}

export function originBadgeClass(o: string): string {
  if (o === "builtin") return "origin-builtin";
  if (o === "plugin") return "origin-plugin";
  return "origin-user";
}

export function SkillTag({
  loc,
  onClick,
}: {
  loc: SkillLocation;
  onClick?: () => void;
}) {
  const isGlobal = loc.scope === "global";
  const p = loc.provider as Provider;
  const label = isGlobal
    ? `${providerLabel(loc.provider)} (Global)`
    : `${loc.project_name || "Projeto"} (${providerLabel(loc.provider)})`;

  return (
    <span
      className={`skill-tag ${loc.provider} ${isGlobal ? "global" : "project"} ${originBadgeClass(loc.origin)}`}
      title={`${loc.skill_path}\nOrigem: ${originLabel(loc.origin)}\nClique para abrir pasta`}
      onClick={onClick}
    >
      {p === "claude" || p === "antigravity" || p === "codex" ? (
        <ProviderIcon p={p} />
      ) : (
        <span className="skill-tag-dot" style={{ background: providerColor(loc.provider) }} />
      )}
      <span className="skill-tag-text">{label}</span>
      <span className={`skill-tag-origin-dot ${originBadgeClass(loc.origin)}`} title={originLabel(loc.origin)} />
    </span>
  );
}

export function SkillLocationPopover({
  locations,
  skillName,
  openFolder,
  maxVisible = 3,
}: {
  locations: SkillLocation[];
  skillName: string;
  openFolder: (path: string) => void;
  maxVisible?: number;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const visibleLocations = locations.slice(0, maxVisible);
  const hiddenLocations = locations.slice(maxVisible);
  const hasHidden = hiddenLocations.length > 0;

  const handleMouseEnter = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
    }, 200);
  };

  const toggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  };

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    window.addEventListener("mousedown", handleOutsideClick);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handleOutsideClick);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div
      className="skill-tags-wrapper"
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="skill-tags-list">
        {visibleLocations.map((loc, idx) => (
          <SkillTag
            key={`${loc.provider}:${loc.skill_path}:${idx}`}
            loc={loc}
            onClick={() => openFolder(loc.skill_path)}
          />
        ))}

        {hasHidden && (
          <button
            type="button"
            className={`skill-tags-more-btn ${open ? "active" : ""}`}
            onClick={toggleClick}
            aria-label={`Ver mais ${hiddenLocations.length} locais de ${skillName}`}
            title={`Ver mais ${hiddenLocations.length} locais`}
          >
            <span>+{hiddenLocations.length} ...</span>
          </button>
        )}
      </div>

      {open && (
        <div
          className="skill-popover"
          ref={popoverRef}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="skill-popover-head">
            <span className="skill-popover-title">Locais & Origens ({locations.length})</span>
            <span className="skill-popover-skill">{skillName}</span>
          </div>

          <div className="skill-popover-list">
            {locations.map((loc, idx) => {
              const p = loc.provider as Provider;
              const isGlobal = loc.scope === "global";
              return (
                <div
                  key={`${loc.skill_path}:${idx}`}
                  className="skill-popover-item"
                  title={loc.skill_path}
                >
                  <div className="skill-popover-badge">
                    {p === "claude" || p === "antigravity" || p === "codex" ? (
                      <ProviderIcon p={p} />
                    ) : (
                      <span
                        className="skill-tag-dot"
                        style={{ background: providerColor(loc.provider) }}
                      />
                    )}
                    <span className="provider-name">{providerLabel(loc.provider)}</span>
                  </div>

                  <div className="skill-popover-info">
                    <div className="skill-popover-target">
                      <span className={isGlobal ? "scope-global" : "scope-project"}>
                        {isGlobal ? "Global" : loc.project_name || "Projeto"}
                      </span>
                      <span className={`origin-badge ${originBadgeClass(loc.origin)}`}>
                        {originLabel(loc.origin)}
                      </span>
                    </div>
                    <div className="skill-popover-path">{loc.skill_path}</div>
                  </div>

                  <button
                    type="button"
                    className="skill-popover-action"
                    onClick={() => openFolder(loc.skill_path)}
                    title="Abrir pasta no Explorer"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16">
                      <path
                        d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3h-4a1 1 0 0 0-1 1.5Z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                    </svg>
                    Abrir
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
