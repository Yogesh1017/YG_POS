"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, errorText, setToken } from "./api";
import type { Role, Settings, User } from "./types";

type Status = "loading" | "needs_setup" | "signed_out" | "ready" | "error";
interface SessionValue {
  status: Status; user: User | null; settings: Settings | null; error: string | null;
  refresh: () => Promise<void>;
  signIn: (token: string) => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Pick<SessionValue, "status" | "user" | "settings" | "error">>({ status: "loading", user: null, settings: null, error: null });

  const load = useCallback(async () => {
    try {
      const s = await api<{ setup_complete: boolean; user: User | null }>("app.status");
      if (!s.setup_complete) return setState({ status: "needs_setup", user: null, settings: null, error: null });
      if (!s.user) return setState({ status: "signed_out", user: null, settings: null, error: null });
      setState({ status: "ready", user: s.user, settings: await api<Settings>("settings.get"), error: null });
    } catch (e) {
      setState({ status: "error", user: null, settings: null, error: errorText(e) });
    }
  }, []);

  useEffect(() => {
    void load();
    const onSignedOut = () => void load();
    window.addEventListener("ygpos-signed-out", onSignedOut);
    return () => window.removeEventListener("ygpos-signed-out", onSignedOut);
  }, [load]);

  const signIn = useCallback(async (t: string) => { setToken(t); await load(); }, [load]);
  const signOut = useCallback(async () => {
    try { await api("auth.logout"); } catch { /* signing out locally is enough */ }
    setToken(null);
    await load();
  }, [load]);

  const value = useMemo(() => ({ ...state, refresh: load, signIn, signOut }), [state, load, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside SessionProvider");
  return v;
}

/** For screens inside the signed-in area, where the user and business settings are guaranteed. */
export function useShop(): { user: User; settings: Settings; role: Role; canManage: boolean; isOwner: boolean; gst: boolean; refresh: () => Promise<void> } {
  const s = useSession();
  if (!s.user || !s.settings) throw new Error("useShop used outside the signed-in area");
  return { user: s.user, settings: s.settings, role: s.user.role, canManage: s.user.role !== "cashier", isOwner: s.user.role === "owner", gst: !!s.settings.gst_registered, refresh: s.refresh };
}
