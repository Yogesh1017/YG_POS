"use client";
// The interface never touches the database. It asks the core, which lives in the desktop app's
// main process and is reached through the app's own private address (no internet involved).
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly data?: unknown) {
    super(message);
  }
}

const TOKEN_KEY = "ygpos-session";
let token: string | null = null;
export function getToken(): string | null {
  if (token === null && typeof sessionStorage !== "undefined") token = sessionStorage.getItem(TOKEN_KEY);
  return token;
}
export function setToken(t: string | null): void {
  token = t;
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
}

/** Call a core method. Throws ApiError with a message that can be shown to the user. */
export async function api<T = unknown>(method: string, args: unknown = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch("/api/rpc", { method: "POST", headers: { "content-type": "application/json", "x-session": getToken() ?? "" }, body: JSON.stringify({ method, args }) });
  } catch {
    throw new ApiError("The app's data service is not responding. Close YG POS and open it again.", "internal");
  }
  const body = (await res.json()) as { ok: true; data: T } | { ok: false; error: { code: string; message: string; data?: unknown } };
  if (body.ok) return body.data;
  if (body.error.code === "auth" && getToken()) {
    setToken(null);
    window.dispatchEvent(new Event("ygpos-signed-out"));
  }
  throw new ApiError(body.error.message, body.error.code, body.error.data);
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : "Something went wrong.");

/** Load data with loading / error / reload state. Re-runs when args change. Stale answers are ignored. */
export function useApi<T>(method: string | null, args: unknown = {}) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!method });
  const seq = useRef(0);
  const key = JSON.stringify([method, args]);
  const reload = useCallback(async () => {
    const [m, a] = JSON.parse(key) as [string | null, unknown];
    if (!m) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api<T>(m, a);
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (mine === seq.current) setState({ data: null, error: errorText(e), loading: false });
    }
  }, [key]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}

export const newRef = (): string => crypto.randomUUID();

export function downloadCsv(filename: string, rows: (string | number | null)[][]): void {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c ?? "")) ? `"${String(c).replace(/"/g, '""')}"` : String(c ?? ""))).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- dates (this computer's local time)
const pad = (n: number) => String(n).padStart(2, "0");
export const today = (offsetDays = 0): string => {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const formatDate = (ymd: string | null | undefined): string => {
  if (!ymd || ymd.startsWith("0000")) return "";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};
export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
export const fyOf = (ymd: string): string => {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  const s = m >= 4 ? y : y - 1;
  return `${pad(s % 100)}-${pad((s + 1) % 100)}`;
};
