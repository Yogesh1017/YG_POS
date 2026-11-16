import { create } from "zustand";
import { db } from "./db";
import { errorMessage, isAuthError, isNetworkError, supabase } from "./supabase";
import { qtyToMilli } from "./money";
import type { Category, Customer, LocalSale, Product } from "./types";

interface SyncState {
  online: boolean;
  syncing: boolean;
  lastSyncedAt: string | null;
  /** Set when the last attempt could not reach the server or the session expired. */
  problem: string | null;
}

export const useSyncStore = create<SyncState>(() => ({
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  syncing: false,
  lastSyncedAt: null,
  problem: null,
}));

const PAGE = 1000;

async function fetchAll<T>(table: string, businessId: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase()
      .from(table).select("*").eq("business_id", businessId).order("id").range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

/** Replace the on-device catalog with the server's, then re-apply stock used by sales still waiting to sync. */
export async function pullCatalog(businessId: string): Promise<void> {
  const [products, categories, customers] = await Promise.all([
    fetchAll<Product>("products", businessId),
    fetchAll<Category>("categories", businessId),
    fetchAll<Customer>("customers", businessId),
  ]);
  await db.transaction("rw", db.products, db.categories, db.customers, db.sales, async () => {
    const pending = await db.sales.where({ business_id: businessId, status: "pending" }).toArray();
    const used = new Map<string, number>();
    for (const s of pending) {
      for (const i of s.payload.items) used.set(i.product_id, (used.get(i.product_id) ?? 0) + qtyToMilli(Number(i.qty)));
    }
    for (const p of products) {
      const u = used.get(p.id);
      if (u && p.track_stock) p.stock_qty = (qtyToMilli(p.stock_qty) - u) / 1000;
    }
    await db.products.where("business_id").equals(businessId).delete();
    await db.categories.where("business_id").equals(businessId).delete();
    await db.customers.where("business_id").equals(businessId).delete();
    await db.products.bulkPut(products);
    await db.categories.bulkPut(categories);
    await db.customers.bulkPut(customers);
  });
}

const KEEP_SYNCED_DAYS = 14;

/**
 * Send sales waiting on this device to the server, oldest first.
 * Safe to call any number of times: create_sale() is idempotent on the sale id, so a sale
 * whose confirmation was lost (connection dropped mid-request) is simply confirmed on retry.
 */
async function pushSales(businessId: string): Promise<{ sent: number; problem: string | null }> {
  const pending = await db.sales.where({ business_id: businessId, status: "pending" }).sortBy("sold_at");
  let sent = 0;
  for (const sale of pending) {
    const { data, error } = await supabase().rpc("create_sale", { p: sale.payload });
    if (!error) {
      await db.sales.update(sale.id, {
        status: "synced", invoice_no: data.invoice_no, error: null, synced_at: new Date().toISOString(),
        invoice: { ...sale.invoice, invoiceNo: data.invoice_no },
      });
      sent += 1;
      continue;
    }
    if (isNetworkError(error)) return { sent, problem: "offline" };
    if (isAuthError(error)) return { sent, problem: "Your session has expired. Sign in again to upload waiting bills." };
    // The server looked at the sale and refused it. Retrying will not help; keep it for the owner to review.
    await db.sales.update(sale.id, { status: "failed", error: errorMessage(error), attempts: sale.attempts + 1 });
  }
  const cutoff = new Date(Date.now() - KEEP_SYNCED_DAYS * 86400000).toISOString();
  await db.sales.where("sold_at").below(cutoff).and((s) => s.status === "synced").delete();
  return { sent, problem: null };
}

let running: Promise<void> | null = null;

/** Upload waiting sales, then refresh the catalog. Calls made while a sync is running share that run. */
export function syncNow(businessId: string): Promise<void> {
  running ??= (async () => {
    useSyncStore.setState({ syncing: true });
    try {
      const run = async () => {
        const pushed = await pushSales(businessId);
        if (pushed.problem) {
          useSyncStore.setState({ problem: pushed.problem === "offline" ? null : pushed.problem, online: pushed.problem !== "offline" });
          return;
        }
        await pullCatalog(businessId);
        useSyncStore.setState({ lastSyncedAt: new Date().toISOString(), problem: null, online: true });
      };
      // One tab syncs at a time (other tabs wait), where the browser supports it.
      if (typeof navigator !== "undefined" && navigator.locks) await navigator.locks.request("ygpos-sync", run);
      else await run();
    } catch (e) {
      const err = e as { message: string; code?: string };
      if (isNetworkError(err)) useSyncStore.setState({ online: false });
      else useSyncStore.setState({ problem: errorMessage(err) });
    } finally {
      useSyncStore.setState({ syncing: false });
      running = null;
    }
  })();
  return running;
}

/** Put a failed sale back in the queue (after the cause has been fixed). */
export async function retrySale(sale: LocalSale): Promise<void> {
  await db.sales.update(sale.id, { status: "pending", error: null });
  await syncNow(sale.business_id);
}

/** Keep trying in the background: on reconnect, when the tab becomes visible, and every 30 seconds. */
export function startBackgroundSync(businessId: string): () => void {
  const kick = () => void syncNow(businessId);
  const onOnline = () => {
    useSyncStore.setState({ online: true });
    kick();
  };
  const onOffline = () => useSyncStore.setState({ online: false });
  const onVisible = () => document.visibilityState === "visible" && kick();
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(async () => {
    const waiting = await db.sales.where({ business_id: businessId, status: "pending" }).count();
    if (waiting > 0 || !useSyncStore.getState().lastSyncedAt) kick();
  }, 30000);
  const slow = window.setInterval(kick, 5 * 60000);
  kick();
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
    window.clearInterval(slow);
  };
}
