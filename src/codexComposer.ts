import { useEffect, useRef, useState } from "react";
import { api, type AppMention, type CodexIntegrations, type Session } from "./api";
import type { PlusMenuGroup } from "./ComposerParts";

export function useCodexIntegrations(session: Session, insert: (text: string) => void, mention: (item: AppMention) => void) {
  const [data, setData] = useState<CodexIntegrations>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    setData(undefined); setError(undefined); setLoading(false); pending.current = false;
    return () => { generation.current++; };
  }, [session.provider, session.id, session.project]);

  const load = async () => {
    if (session.provider !== "codex" || pending.current) return;
    const current = generation.current;
    pending.current = true; setLoading(true); setError(undefined);
    try {
      const result = await api.integrations(session);
      if (current === generation.current) setData(result);
    } catch (e) {
      if (current === generation.current) setError(String(e));
    } finally {
      if (current === generation.current) { pending.current = false; setLoading(false); }
    }
  };

  const groups: PlusMenuGroup[] = session.provider !== "codex" ? [] : [
    {
      id: "connectors", label: "Conectores", loading,
      error: error ?? [data?.errors.apps, data?.errors.mcp].filter(Boolean).join(" · "),
      items: [
        ...(data?.apps ?? []).map((app) => ({
          id: `app:${app.id}`, label: app.name,
          detail: !app.isAccessible ? "Não conectado" : !app.isEnabled ? "Desativado" : app.description ?? "Conectado",
          disabled: !app.isAccessible || !app.isEnabled,
          onSelect: () => {
            const token = `$${app.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`;
            mention({name: app.name, path: `app://${app.id}`, token});
            insert(`${token} `);
          },
        })),
        ...(data?.mcp ?? []).map((server) => ({
          id: `mcp:${server.name}`, label: server.name,
          detail: server.toolsError ? `MCP · ${server.toolsError}` : `MCP · ${Object.keys(server.tools ?? {}).length} ferramentas · ${server.runtimeStatus ?? server.authStatus}`,
          disabled: !!server.toolsError || !Object.keys(server.tools ?? {}).length,
          onSelect: () => insert(`Use o servidor MCP ${JSON.stringify(server.name)}: `),
        })),
      ],
    },
    {
      id: "plugins", label: "Plugins", loading,
      error: error ?? data?.errors.plugins ?? data?.plugins.marketplaceLoadErrors?.map((e) => e.message).join(" · "),
      items: (data?.plugins.marketplaces ?? []).flatMap((marketplace) => marketplace.plugins.map((plugin) => ({
        id: `${marketplace.name}:${plugin.id}`, label: plugin.interface?.displayName ?? plugin.name,
        detail: !plugin.installed ? "Não instalado" : !plugin.enabled ? "Desativado" : plugin.interface?.shortDescription ?? "Instalado",
        disabled: !plugin.installed || !plugin.enabled,
        onSelect: () => insert(`Use o plugin ${JSON.stringify(plugin.name)}: `),
      }))),
    },
  ];
  return { groups, load };
}
