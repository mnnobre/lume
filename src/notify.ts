import { useEffect, useRef, useState } from "react";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { api, PROVIDERS, projectName, type Session } from "./api";

const KEY = "lume.notifications";

export function useNotificationsSetting() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== "off";
    } catch {
      return true;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? "on" : "off");
    } catch {}
  };
  return { on, set };
}

/**
 * Notificação do Windows quando a IA termina ou pede aprovação e o Lume não está em primeiro plano.
 * Com o Lume em foco não notifica: a linha ao vivo e o indicador da barra lateral já mostram.
 */
export function useTurnNotifications(enabled: boolean, sessions: Session[] | null) {
  const byKey = useRef(new Map<string, Session>());
  byKey.current = new Map((sessions ?? []).map((s) => [`${s.provider}:${s.id}`, s]));
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    let granted: boolean | null = null;
    const allowed = async () => {
      if (granted === null) granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
      return granted;
    };
    const un = api.onLive(async (e) => {
      if (!enabledRef.current || document.hasFocus()) return;
      if (e.kind !== "done" && e.kind !== "approval" && e.kind !== "request") return;
      if (!(await allowed())) return;
      const s = byKey.current.get(`${e.provider}:${e.id}`);
      const where = s ? `${s.title} · ${projectName(s.project)}` : PROVIDERS[e.provider];
      if (e.kind === "request") sendNotification({title:`${PROVIDERS[e.provider]} precisa da sua resposta`,body:where});
      else if (e.kind === "approval") sendNotification({ title: `${PROVIDERS[e.provider]} precisa da sua aprovação`, body: `${e.tool} — ${where}` });
      else sendNotification({ title: e.error ? `${PROVIDERS[e.provider]}: o turno falhou` : `${PROVIDERS[e.provider]} terminou`, body: e.error ?? where });
    });
    return () => void un.then((f) => f());
  }, []);
}
