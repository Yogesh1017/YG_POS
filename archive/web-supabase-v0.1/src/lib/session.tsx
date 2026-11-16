"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { db } from "./db";
import { isNetworkError, isSupabaseConfigured, supabase } from "./supabase";
import type { Business, Member, Role } from "./types";
import { useCart } from "@/stores/cart";

const LAST_USER_KEY = "ygpos-last-user";
const SESSION_READY = "ygpos-session-ready";

type Status = "loading" | "signed_out" | "no_business" | "ready" | "error";

interface SessionValue {
  status: Status;
  userId: string | null;
  email: string | null;
  member: Member | null;
  business: Business | null;
  error: string | null;
  /** Re-read membership and business from the server (after settings change, setup, etc.). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<SessionValue, "refresh" | "signOut">>({
    status: "loading", userId: null, email: null, member: null, business: null, error: null,
  });

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setState((s) => ({ ...s, status: "error", error: "This app is not connected to a database yet. Set the Supabase URL and key (see README)." }));
      return;
    }
    // Offline start: getSession() reads the stored session, but if the access token has expired it
    // tries to refresh it over the network and can wait a long time. A till must open regardless, so
    // when there is no connection (or no answer within a few seconds) carry on as the person who last
    // used this device. The token refreshes by itself once the connection returns; until then bills
    // are queued locally.
    const lastUser = localStorage.getItem(LAST_USER_KEY);
    const cached = lastUser ? await db.sessions.get(lastUser) : undefined;
    const continueAsCached = () => {
      if (!cached) return false;
      setState({ status: "ready", userId: cached.user_id, email: cached.member.email, member: cached.member, business: cached.business, error: null });
      return true;
    };
    const pending = supabase().auth.getSession();
    const first = await Promise.race([pending, new Promise<"slow">((r) => setTimeout(() => r("slow"), navigator.onLine ? 4000 : 0))]);
    if (first === "slow" && continueAsCached()) {
      void pending.then(({ data }) => { if (data.session) window.dispatchEvent(new Event(SESSION_READY)); });
      return;
    }
    const { data: { session }, error: sessionError } = await pending;
    if (!session) {
      const offline = !!sessionError && (sessionError.name === "AuthRetryableFetchError" || isNetworkError(sessionError));
      if (offline && continueAsCached()) return;
      setState({ status: "signed_out", userId: null, email: null, member: null, business: null, error: null });
      return;
    }
    const userId = session.user.id;
    const email = session.user.email ?? null;
    const { data, error } = await supabase()
      .from("business_members").select("*, businesses(*)").eq("user_id", userId).eq("is_active", true)
      .order("created_at").limit(1);
    if (error) {
      // Offline (or server unreachable): carry on with what this device last knew.
      const known = await db.sessions.get(userId);
      if (known && isNetworkError(error)) {
        setState({ status: "ready", userId, email, member: known.member, business: known.business, error: null });
      } else {
        setState({ status: "error", userId, email, member: null, business: null,
          error: isNetworkError(error) ? "Connect to the internet once to finish signing in on this device." : error.message });
      }
      return;
    }
    if (!data || data.length === 0) {
      await db.sessions.delete(userId);
      setState({ status: "no_business", userId, email, member: null, business: null, error: null });
      return;
    }
    const { businesses, ...member } = data[0] as Member & { businesses: Business };
    await db.sessions.put({ user_id: userId, member, business: businesses, cached_at: new Date().toISOString() });
    localStorage.setItem(LAST_USER_KEY, userId);
    setState({ status: "ready", userId, email, member, business: businesses, error: null });
  }, []);

  useEffect(() => {
    void load();
    if (!isSupabaseConfigured) return;
    const onOnline = () => void load(); // pick up settings/role changes made while this device was offline
    window.addEventListener("online", onOnline);
    window.addEventListener(SESSION_READY, onOnline);
    const { data } = supabase().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") void load();
    });
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("online", onOnline);
      window.removeEventListener(SESSION_READY, onOnline);
    };
  }, [load]);

  const signOut = useCallback(async () => {
    await supabase().auth.signOut({ scope: "local" });
    localStorage.removeItem(LAST_USER_KEY);
    useCart.getState().clear(); // a half-built bill must not carry over to the next person
    setState({ status: "signed_out", userId: null, email: null, member: null, business: null, error: null });
  }, []);

  const value = useMemo(() => ({ ...state, refresh: load, signOut }), [state, load, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside SessionProvider");
  return v;
}

/** For screens rendered inside the signed-in shell, where business and member are guaranteed. */
export function useShop(): { business: Business; member: Member; role: Role; canManage: boolean; isOwner: boolean; refresh: () => Promise<void> } {
  const s = useSession();
  if (!s.business || !s.member) throw new Error("useShop used outside the signed-in area");
  const role = s.member.role;
  return { business: s.business, member: s.member, role, canManage: role !== "cashier", isOwner: role === "owner", refresh: s.refresh };
}
