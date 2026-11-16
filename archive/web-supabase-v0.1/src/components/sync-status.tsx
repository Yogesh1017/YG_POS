"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { AlertTriangle, CloudOff, RefreshCw, CloudCheck, CloudUpload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Dialog, cn } from "@/components/ui";
import { db } from "@/lib/db";
import { billRef, formatDateTime } from "@/lib/invoice";
import { formatINR } from "@/lib/money";
import { retrySale, syncNow, useSyncStore } from "@/lib/sync";

export function SyncStatus({ businessId, compact }: { businessId: string; compact?: boolean }) {
  const { online, syncing, lastSyncedAt, problem } = useSyncStore();
  const [open, setOpen] = useState(false);
  const waiting = useLiveQuery(() => db.sales.where({ business_id: businessId, status: "pending" }).sortBy("sold_at"), [businessId]) ?? [];
  const failed = useLiveQuery(() => db.sales.where({ business_id: businessId, status: "failed" }).sortBy("sold_at"), [businessId]) ?? [];

  const tone = failed.length || problem ? "danger" : !online || waiting.length ? "warn" : "ok";
  const Icon = failed.length || problem ? AlertTriangle : !online ? CloudOff : waiting.length ? CloudUpload : CloudCheck;
  const label = failed.length ? `${failed.length} bill${failed.length > 1 ? "s" : ""} need attention`
    : problem ? "Sync problem"
    : !online ? (waiting.length ? `Offline · ${waiting.length} waiting` : "Offline")
    : waiting.length ? `${waiting.length} waiting to upload` : "All saved";

  return (
    <>
      <button onClick={() => setOpen(true)} title="Sync status" className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-2",
        tone === "danger" && "text-danger", tone === "warn" && "text-warn", tone === "ok" && "text-muted",
      )}>
        <Icon className={cn("size-4 shrink-0", syncing && "animate-pulse")} aria-hidden />
        <span className={cn(compact && "sr-only")}>{label}</span>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Sync status" footer={
        <Button variant="primary" loading={syncing} disabled={!online && !syncing} onClick={async () => { await syncNow(businessId); if (!useSyncStore.getState().online) toast.error("Still offline"); }}>
          <RefreshCw className="size-4" /> Sync now
        </Button>
      }>
        <div className="space-y-4 text-sm">
          <p>
            {online ? "Connected." : "No connection — billing keeps working. Bills are stored on this device and upload by themselves when the internet is back."}
            {lastSyncedAt && <span className="text-muted"> Last synced {formatDateTime(lastSyncedAt)}.</span>}
          </p>
          {problem && <p className="rounded-md bg-danger-soft px-3 py-2 text-danger">{problem}</p>}
          {failed.length > 0 && (
            <div>
              <p className="mb-2 font-medium text-danger">The server did not accept these bills</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {failed.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div>
                      <div className="num">{billRef(s.id)} · {formatINR(s.invoice.totals.grand)} <span className="text-muted">· {formatDateTime(s.sold_at)}</span></div>
                      <div className="text-xs text-danger">{s.error}</div>
                    </div>
                    <Button size="sm" onClick={() => void retrySale(s)}>Retry</Button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">These stay on this device until they upload. Fix the cause (shown above), then retry. Do not clear browser data.</p>
            </div>
          )}
          <div>
            <p className="mb-2 font-medium">Waiting to upload <Badge>{waiting.length}</Badge></p>
            {waiting.length === 0 ? <p className="text-muted">Nothing waiting.</p> : (
              <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                {waiting.map((s) => (
                  <li key={s.id} className="num flex justify-between px-3 py-2"><span>{billRef(s.id)} <span className="text-muted">{formatDateTime(s.sold_at)}</span></span><span>{formatINR(s.invoice.totals.grand)}</span></li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
