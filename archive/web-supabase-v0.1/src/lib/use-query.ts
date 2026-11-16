"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./supabase";

/** Load data from the server with loading / error / reload state. Stale responses are ignored. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const latest = useRef(fn);
  useEffect(() => { latest.current = fn; });
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await latest.current();
      if (mine === seq.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (mine === seq.current) setState({ data: null, error: errorMessage(e as { message: string; code?: string }), loading: false });
    }
  }, []);
  // Re-run whenever the caller's dependencies change (compared by value, they are small primitives/objects).
  const key = JSON.stringify(deps);
  useEffect(() => { void reload(); }, [reload, key]);
  return { ...state, reload };
}

/** Unwrap a Supabase response, throwing its error so useQuery can show it. */
export function unwrap<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

export function downloadCsv(filename: string, rows: (string | number)[][]): void {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
