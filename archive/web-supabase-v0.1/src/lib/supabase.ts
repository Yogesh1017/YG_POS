import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

/** Browser Supabase client. The session lives in localStorage so the till stays signed in while offline. */
export function supabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  client ??= createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return client;
}

interface ApiError {
  message: string;
  code?: string;
  details?: string | null;
}

/** True when the request never reached the server (offline, DNS, timeout) — safe to retry later. */
export function isNetworkError(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return !error.code && /fetch|network|load failed|timeout|abort/i.test(error.message ?? "");
}

/** True when the server refused because the session is missing/expired — sign in again, then retry. */
export function isAuthError(error: ApiError | null | undefined): boolean {
  return !!error && (error.code === "PGRST301" || error.code === "PGRST303" || error.code === "28000" || /jwt/i.test(error.message ?? ""));
}

const FRIENDLY: Record<string, string> = {
  "23505": "That value is already in use.",
  "23503": "This record is used elsewhere and cannot be removed.",
  "42501": "You do not have permission to do that.",
};

/** A message fit to show the user. Our own database functions raise readable messages; pass those through. */
export function errorMessage(error: ApiError | null | undefined, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback;
  if (isNetworkError(error)) return "No connection to the server. Check the internet and try again.";
  const msg = error.message ?? "";
  if (/duplicate key.*barcode/i.test(msg)) return "Another product already uses this barcode.";
  if (/duplicate key.*sku/i.test(msg)) return "Another product already uses this SKU.";
  if (/duplicate key.*phone/i.test(msg)) return "Another customer already has this phone number.";
  if (/duplicate key.*categories_name/i.test(msg)) return "A category with this name already exists.";
  if (/gst_details_required/.test(msg)) return "A GST-registered business needs a GSTIN whose first two digits match the state.";
  if (/violates (foreign key|check|row-level)|duplicate key|permission denied/i.test(msg)) {
    return FRIENDLY[error.code ?? ""] ?? fallback;
  }
  return msg || fallback;
}
