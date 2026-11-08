use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::sessions::{codex_home, Store};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SkillLocation {
    pub provider: String, // "claude" | "antigravity" | "codex" | "shared"
    pub scope: String,    // "global" | "project"
    pub origin: String,   // "builtin" | "plugin" | "user"
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub skill_path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AggregatedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub locations: Vec<SkillLocation>,
    pub origins: Vec<String>, // ["builtin", "plugin", "user"]
}

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_default())
}

fn project_name(path_str: &str) -> String {
    let norm = path_str.replace('\\', "/");
    let trimmed = norm.trim_end_matches('/');
    trimmed
        .split('/')
        .last()
        .filter(|s| !s.is_empty())
        .unwrap_or(path_str)
        .to_string()
}

/// Lê o início de um arquivo markdown procurando frontmatter YAML (name e description)
/// ou fallback no primeiro título e parágrafo.
fn parse_skill_markdown(path: &Path) -> (Option<String>, Option<String>) {
    let Ok(file) = File::open(path) else {
        return (None, None);
    };

    let reader = BufReader::new(file.take(16 * 1024)); // limita leitura a 16 KB
    let lines: Vec<String> = reader.lines().filter_map(|l| l.ok()).collect();

    let mut name = None;
    let mut description = None;

    if lines.first().map(|l| l.trim()) == Some("---") {
        let mut in_frontmatter = true;
        let mut capturing_desc = false;
        let mut desc_buf = String::new();

        for line in lines.iter().skip(1) {
            let trimmed = line.trim();
            if trimmed == "---" {
                in_frontmatter = false;
                break;
            }

            if capturing_desc {
                if trimmed.starts_with(|c: char| c.is_alphabetic() && line.contains(':')) {
                    capturing_desc = false;
                } else {
                    if !desc_buf.is_empty() {
                        desc_buf.push(' ');
                    }
                    desc_buf.push_str(trimmed);
                    continue;
                }
            }

            if let Some(val) = trimmed.strip_prefix("name:") {
                let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                if !clean.is_empty() && name.is_none() {
                    name = Some(clean.to_string());
                }
            } else if let Some(val) = trimmed.strip_prefix("description:") {
                let clean = val.trim().trim_matches(|c| c == '"' || c == '\'');
                if clean == ">" || clean == "|" {
                    capturing_desc = true;
                } else if !clean.is_empty() {
                    desc_buf = clean.to_string();
                    capturing_desc = true;
                }
            }
        }

        if !desc_buf.is_empty() {
            description = Some(desc_buf);
        }

        if in_frontmatter {
            // Frontmatter não fechado, continua
        }
    }

    // Se não encontrou name ou description, busca em títulos e parágrafos
    if name.is_none() {
        for line in &lines {
            let trimmed = line.trim();
            if let Some(h) = trimmed.strip_prefix("# ") {
                let clean = h.trim();
                if !clean.is_empty() {
                    name = Some(clean.to_string());
                    break;
                }
            }
        }
    }

    if description.is_none() {
        let mut found_non_header = false;
        let mut desc_buf = String::new();
        for line in &lines {
            let trimmed = line.trim();
            if trimmed == "---" || trimmed.starts_with('#') || trimmed.is_empty() {
                if found_non_header && !desc_buf.is_empty() {
                    break;
                }
                continue;
            }
            found_non_header = true;
            if !desc_buf.is_empty() {
                desc_buf.push(' ');
            }
            desc_buf.push_str(trimmed);
            if desc_buf.len() > 300 {
                break;
            }
        }
        if !desc_buf.is_empty() {
            description = Some(desc_buf);
        }
    }

    (name, description)
}

struct DiscoveredRawSkill {
    name: String,
    description: String,
    skill_path: String,
    provider: String,
    scope: String,
    origin: String,
    project_path: Option<String>,
    project_name: Option<String>,
}

fn inspect_skill_entry(
    entry_path: &Path,
    provider: &str,
    scope: &str,
    origin: &str,
    project_path: Option<&str>,
) -> Option<DiscoveredRawSkill> {
    let (target_md, base_name) = if entry_path.is_dir() {
        let folder_name = entry_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();

        if folder_name.starts_with('.') || folder_name == "node_modules" {
            return None;
        }

        let skill_md = entry_path.join("SKILL.md");
        let skill_md_alt = entry_path.join("skill.md");
        let readme_md = entry_path.join("README.md");

        let found_md = if skill_md.exists() {
            Some(skill_md)
        } else if skill_md_alt.exists() {
            Some(skill_md_alt)
        } else if readme_md.exists() {
            Some(readme_md)
        } else {
            None
        };

        (found_md, folder_name)
    } else if entry_path.is_file() {
        let ext = entry_path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext.eq_ignore_ascii_case("md") {
            let stem = entry_path
                .file_stem()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            (Some(entry_path.to_path_buf()), stem)
        } else {
            return None;
        }
    } else {
        return None;
    };

    let (parsed_name, parsed_desc) = if let Some(ref md) = target_md {
        parse_skill_markdown(md)
    } else {
        (None, None)
    };

    let final_name = parsed_name.unwrap_or(base_name);
    let final_desc = parsed_desc.unwrap_or_default();
    let skill_path_str = entry_path.to_string_lossy().to_string();

    Some(DiscoveredRawSkill {
        name: final_name,
        description: final_desc,
        skill_path: skill_path_str,
        provider: provider.to_string(),
        scope: scope.to_string(),
        origin: origin.to_string(),
        project_path: project_path.map(|s| s.to_string()),
        project_name: project_path.map(project_name),
    })
}

fn scan_skills_directory(
    dir: &Path,
    provider: &str,
    scope: &str,
    default_origin: &str,
    project_path: Option<&str>,
    out: &mut Vec<DiscoveredRawSkill>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();

        // Tratamento especial para pasta `synced` no Claude (skills oficiais/built-in)
        if file_name == "synced" && path.is_dir() {
            if let Ok(sub_entries) = fs::read_dir(&path) {
                for sub in sub_entries.flatten() {
                    let sub_p = sub.path();
                    if sub_p.is_dir() {
                        if let Ok(bucket_entries) = fs::read_dir(&sub_p) {
                            for bucket_item in bucket_entries.flatten() {
                                if let Some(raw) = inspect_skill_entry(
                                    &bucket_item.path(),
                                    provider,
                                    scope,
                                    "builtin",
                                    project_path,
                                ) {
                                    out.push(raw);
                                }
                            }
                        }
                    }
                }
            }
            continue;
        }

        // Tratamento especial para pasta `.system` no Codex (skills oficiais/built-in)
        if file_name == ".system" && path.is_dir() {
            if let Ok(sub_entries) = fs::read_dir(&path) {
                for sub in sub_entries.flatten() {
                    let sub_p = sub.path();
                    if sub_p.is_dir() {
                        if let Some(raw) = inspect_skill_entry(
                            &sub_p,
                            provider,
                            scope,
                            "builtin",
                            project_path,
                        ) {
                            out.push(raw);
                        }
                    }
                }
            }
            continue;
        }

        if let Some(raw) = inspect_skill_entry(&path, provider, scope, default_origin, project_path) {
            out.push(raw);
        }
    }
}

fn scan_all_global_skills() -> Vec<DiscoveredRawSkill> {
    let mut out = Vec::new();
    let home = home_dir();

    // 1. Claude Code Global (skills na raiz = user; pasta `synced` = builtin)
    let claude_skills = home.join(".claude").join("skills");
    scan_skills_directory(&claude_skills, "claude", "global", "user", None, &mut out);

    // 2. Antigravity Global
    // - ~/.gemini/skills: criadas pelo usuário
    let gemini_skills = home.join(".gemini").join("skills");
    scan_skills_directory(&gemini_skills, "antigravity", "global", "user", None, &mut out);

    // - ~/.gemini/antigravity/builtin/skills: nativas do harness
    let gemini_builtin_skills = home
        .join(".gemini")
        .join("antigravity")
        .join("builtin")
        .join("skills");
    scan_skills_directory(
        &gemini_builtin_skills,
        "antigravity",
        "global",
        "builtin",
        None,
        &mut out,
    );

    // - ~/.gemini/config/plugins/*/skills: plugins / extensões instaladas
    let gemini_plugins = home.join(".gemini").join("config").join("plugins");
    if let Ok(plugin_dirs) = fs::read_dir(&gemini_plugins) {
        for plugin in plugin_dirs.flatten() {
            let p_skills = plugin.path().join("skills");
            if p_skills.is_dir() {
                scan_skills_directory(&p_skills, "antigravity", "global", "plugin", None, &mut out);
            }
        }
    }

    // 3. Codex Global (na raiz = user; subpasta .system = builtin)
    let codex_skills = codex_home().join("skills");
    scan_skills_directory(&codex_skills, "codex", "global", "user", None, &mut out);

    out
}

fn scan_project_skills(project: &str) -> Vec<DiscoveredRawSkill> {
    let mut out = Vec::new();
    let root = Path::new(project);
    if !root.is_dir() {
        return out;
    }

    // Se o próprio projeto tiver SKILL.md, ele é um skill repository do usuário
    if root.join("SKILL.md").exists() || root.join("skill.md").exists() {
        if let Some(raw) = inspect_skill_entry(root, "shared", "project", "user", Some(project)) {
            out.push(raw);
        }
    }

    // Pastas de skill por ferramenta dentro do projeto
    let checks = [
        (".claude/skills", "claude"),
        (".codex/skills", "codex"),
        (".gemini/skills", "antigravity"),
        (".antigravity/skills", "antigravity"),
        (".agents/skills", "antigravity"),
        ("skills", "shared"),
        ("claude/skills", "claude"),
        ("src/.claude/skills", "claude"),
    ];

    for (rel, provider) in checks {
        let p = root.join(rel);
        if p.is_dir() {
            scan_skills_directory(&p, provider, "project", "user", Some(project), &mut out);
        }
    }

    out
}

#[tauri::command]
pub async fn list_all_skills(
    app: AppHandle,
    projects: Vec<String>,
) -> Result<Vec<AggregatedSkill>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut discovered = scan_all_global_skills();

        // Junta projetos conhecidos: os passados pela UI e os registrados nas sessões
        let mut all_projects = std::collections::BTreeSet::new();
        for p in projects {
            if !p.is_empty() {
                all_projects.insert(p);
            }
        }

        let store = app.state::<Store>();
        if let Ok(guard) = store.sessions.lock() {
            for session in guard.values() {
                if !session.project.is_empty() {
                    all_projects.insert(session.project.clone());
                }
            }
        }

        for p in &all_projects {
            let p_skills = scan_project_skills(p);
            discovered.extend(p_skills);
        }

        // Agrupa por id normalizado
        let mut grouped: HashMap<String, AggregatedSkill> = HashMap::new();

        for item in discovered {
            let norm_id = item
                .name
                .trim()
                .to_lowercase()
                .replace(['_', ' '], "-");

            let location = SkillLocation {
                provider: item.provider,
                scope: item.scope,
                origin: item.origin.clone(),
                project_path: item.project_path,
                project_name: item.project_name,
                skill_path: item.skill_path,
            };

            let entry = grouped.entry(norm_id.clone()).or_insert_with(|| AggregatedSkill {
                id: norm_id,
                name: item.name,
                description: item.description.clone(),
                locations: Vec::new(),
                origins: Vec::new(),
            });

            // Se o skill já existe com descrição vazia e agora achamos com descrição, atualiza
            if entry.description.is_empty() && !item.description.is_empty() {
                entry.description = item.description;
            }

            // Registra a origem se ainda não estiver na lista
            if !entry.origins.contains(&item.origin) {
                entry.origins.push(item.origin);
            }

            // Evita duplicar exatamente a mesma localização
            if !entry.locations.iter().any(|l| l.skill_path == location.skill_path) {
                entry.locations.push(location);
            }
        }

        let mut list: Vec<AggregatedSkill> = grouped.into_values().collect();
        // Ordena alfabeticamente pelo nome
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        Ok(list)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_skill_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_skill_content(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let target = if p.is_dir() {
        let s1 = p.join("SKILL.md");
        let s2 = p.join("skill.md");
        let s3 = p.join("README.md");
        if s1.exists() {
            s1
        } else if s2.exists() {
            s2
        } else if s3.exists() {
            s3
        } else {
            return Err("Nenhum arquivo SKILL.md ou README.md encontrado na pasta".into());
        }
    } else {
        p.to_path_buf()
    };

    fs::read_to_string(&target).map_err(|e| format!("Não foi possível ler o arquivo: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_skill_markdown() {
        let temp_dir = std::env::temp_dir().join("test_skill_parse_2");
        let _ = fs::create_dir_all(&temp_dir);
        let file_path = temp_dir.join("SKILL.md");

        let content = r#"---
name: my-awesome-skill
description: This skill does amazing automated tasks.
---

# Title
Instructions go here.
"#;
        fs::write(&file_path, content).unwrap();

        let (name, desc) = parse_skill_markdown(&file_path);
        assert_eq!(name.as_deref(), Some("my-awesome-skill"));
        assert_eq!(desc.as_deref(), Some("This skill does amazing automated tasks."));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_aggregation_grouping_no_duplicates() {
        let mut grouped: HashMap<String, AggregatedSkill> = HashMap::new();

        let samples = vec![
            DiscoveredRawSkill {
                name: "git-helper".into(),
                description: "Helper for git operations".into(),
                skill_path: "/home/user/.claude/skills/git-helper".into(),
                provider: "claude".into(),
                scope: "global".into(),
                origin: "user".into(),
                project_path: None,
                project_name: None,
            },
            DiscoveredRawSkill {
                name: "git-helper".into(),
                description: "Helper for git operations".into(),
                skill_path: "/projects/projectA/.codex/skills/git-helper".into(),
                provider: "codex".into(),
                scope: "project".into(),
                origin: "user".into(),
                project_path: Some("/projects/projectA".into()),
                project_name: Some("projectA".into()),
            },
            DiscoveredRawSkill {
                name: "git-helper".into(),
                description: "Helper for git operations".into(),
                skill_path: "/home/user/.gemini/antigravity/builtin/skills/git-helper".into(),
                provider: "antigravity".into(),
                scope: "global".into(),
                origin: "builtin".into(),
                project_path: None,
                project_name: None,
            },
        ];

        for item in samples {
            let norm_id = item.name.trim().to_lowercase().replace(['_', ' '], "-");
            let loc = SkillLocation {
                provider: item.provider,
                scope: item.scope,
                origin: item.origin.clone(),
                project_path: item.project_path,
                project_name: item.project_name,
                skill_path: item.skill_path,
            };
            let entry = grouped.entry(norm_id.clone()).or_insert_with(|| AggregatedSkill {
                id: norm_id,
                name: item.name,
                description: item.description,
                locations: Vec::new(),
                origins: Vec::new(),
            });
            if !entry.origins.contains(&item.origin) {
                entry.origins.push(item.origin);
            }
            if !entry.locations.iter().any(|l| l.skill_path == loc.skill_path) {
                entry.locations.push(loc);
            }
        }

        assert_eq!(grouped.len(), 1, "Should not duplicate skill with same name");
        let skill = grouped.get("git-helper").unwrap();
        assert_eq!(skill.locations.len(), 3, "Skill should have 3 distinct locations/tags");
        assert!(skill.origins.contains(&"user".to_string()));
        assert!(skill.origins.contains(&"builtin".to_string()));
    }
}
