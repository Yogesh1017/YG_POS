"use client";
import { Boxes, History, Layers, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { productLabel } from "@/components/pickers";
import { Badge, Button, Card, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { api, errorText, formatDate, formatDateTime, useApi } from "@/lib/api";
import { formatINR, parseQty } from "@/lib/money";
import type { Product } from "@/lib/types";
import { formatQtyM, formatStock, toBaseM } from "@/lib/units";

const REASONS: Record<string, string> = {
  opening: "Opening stock", purchase: "Purchase", purchase_cancel: "Purchase cancelled", sale: "Invoice", sale_cancel: "Invoice cancelled", sale_return: "Customer return",
  adjustment: "Count correction", damaged: "Damaged", melted: "Melted", expired: "Expired",
};
interface Batch { id: number; batch_no: string | null; mfg_date: string | null; expiry_date: string | null; qty_m: number; cost4: number; is_expired: number; product_id?: number; name?: string; base_unit?: string }
const valueOf = (qtyM: number, cost4: number) => Math.round((qtyM * cost4) / 100000);

export default function InventoryPage() {
  return <ManagersOnly><Inventory /></ManagersOnly>;
}

function Inventory() {
  const products = useApi<Product[]>("products.list");
  const expiring = useApi<Batch[]>("stock.expiring", { days: 30 });
  const [filter, setFilter] = useState<"all" | "low" | "out" | "expired">("all");
  const [q, setQ] = useState("");
  const [adjusting, setAdjusting] = useState<{ product: Product; batch?: Batch } | null>(null);
  const [batchesOf, setBatchesOf] = useState<Product | null>(null);
  const [historyOf, setHistoryOf] = useState<Product | null>(null);
  const reload = () => { void products.reload(); void expiring.reload(); };

  const active = useMemo(() => (products.data ?? []).filter((p) => p.is_active), [products.data]);
  const stats = useMemo(() => ({
    low: active.filter((p) => p.sellable_m > 0 && p.sellable_m <= p.low_stock_m).length,
    out: active.filter((p) => p.sellable_m <= 0).length,
    expired: active.filter((p) => p.expired_m > 0).length,
  }), [active]);
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return active.filter((p) => {
      const text = [p.brand_name, p.name, p.pack_size, p.sku].filter(Boolean).join(" ").toLowerCase();
      const ok = filter === "all" || (filter === "out" ? p.sellable_m <= 0 : filter === "expired" ? p.expired_m > 0 : p.sellable_m > 0 && p.sellable_m <= p.low_stock_m);
      return ok && words.every((w) => text.includes(w));
    });
  }, [active, q, filter]);

  if (!products.data) return <Spinner />;
  const expired = (expiring.data ?? []).filter((b) => b.is_expired), soon = (expiring.data ?? []).filter((b) => !b.is_expired);
  return (
    <Page>
      <PageHeader title="Stock" description="Stock is kept in each product's smallest unit and shown in its packing. Deliveries are entered under Purchases; damage, melting, expiry and count corrections are recorded here." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card className="p-4"><div className="text-xs text-muted">Running low</div><div className="num mt-1 text-xl font-semibold text-warn">{stats.low}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted">Out of stock</div><div className="num mt-1 text-xl font-semibold text-danger">{stats.out}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted">Products with expired stock to write off</div><div className="num mt-1 text-xl font-semibold text-danger">{stats.expired}</div></Card>
      </div>
      {(expired.length > 0 || soon.length > 0) && (
        <Card className="mb-4 overflow-hidden">
          <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Expired and expiring within 30 days</h2>
          <table className="w-full text-sm"><tbody className="divide-y divide-border">
            {[...expired, ...soon].map((b) => {
              const p = products.data!.find((x) => x.id === b.product_id);
              return (
                <tr key={b.id}>
                  <td className={td}><span className="font-medium">{p ? productLabel(p) : b.name}</span>{b.batch_no && <span className="num text-muted"> · batch {b.batch_no}</span>}</td>
                  <td className={`${td} num text-right`}>{p ? formatStock(b.qty_m, p.base_unit, p.units) : formatQtyM(b.qty_m)}</td>
                  <td className={td}>{b.is_expired ? <Badge tone="danger">Expired {formatDate(b.expiry_date)}</Badge> : <Badge tone="warn">Expires {formatDate(b.expiry_date)}</Badge>}</td>
                  <td className={`${td} text-right`}>{b.is_expired && p && <Button size="sm" onClick={() => setAdjusting({ product: p, batch: b })}>Write off</Button>}</td>
                </tr>
              );
            })}
          </tbody></table>
          {expired.length > 0 && <p className="border-t border-border px-4 py-2 text-xs text-muted">Expired stock cannot be billed. It stays listed here until it is written off.</p>}
        </Card>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search products" aria-label="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-52" aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All products</option><option value="low">Running low</option><option value="out">Out of stock</option><option value="expired">Has expired stock</option>
        </Select>
      </div>
      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState icon={<Boxes />} title={active.length === 0 ? "No products yet" : "Nothing matches"}>{active.length === 0 ? "Add products first, then enter opening stock or a purchase." : "Try a different search or filter."}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Product</th><th className={`${th} text-right`}>In stock</th><th className={`${th} text-right`}>In {`smallest unit`}</th><th className={`${th} text-right`}>Warn at</th><th className={`${th} text-right`}>Value at cost</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className={td}><span className="font-medium">{productLabel(p)}</span> {p.sellable_m <= 0 ? <Badge tone="danger">Out</Badge> : p.sellable_m <= p.low_stock_m ? <Badge tone="warn">Low</Badge> : null} {p.expired_m > 0 && <Badge tone="danger">Expired: {formatQtyM(p.expired_m)} {p.base_unit}</Badge>} {p.shortfall_m > 0 && <Badge tone="danger">Sold without stock: {formatQtyM(p.shortfall_m)}</Badge>}</td>
                    <td className={`${td} num text-right font-medium`}>{formatStock(p.on_hand_m, p.base_unit, p.units)}</td>
                    <td className={`${td} num text-right text-muted`}>{formatQtyM(p.on_hand_m)} {p.base_unit}</td>
                    <td className={`${td} num text-right text-muted`}>{formatQtyM(p.low_stock_m)}</td>
                    <td className={`${td} num text-right text-muted`}>{formatINR(valueOf(Math.max(p.on_hand_m, 0), p.cost4))}</td>
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <Button size="sm" onClick={() => setAdjusting({ product: p })}><SlidersHorizontal className="size-4" /> Adjust</Button>{" "}
                      <Button size="sm" variant="ghost" aria-label={`Batches of ${p.name}`} title="Batches and expiry" onClick={() => setBatchesOf(p)}><Layers className="size-4" /></Button>
                      <Button size="sm" variant="ghost" aria-label={`Stock history of ${p.name}`} title="Stock history" onClick={() => setHistoryOf(p)}><History className="size-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adjusting && <AdjustDialog {...adjusting} onClose={() => setAdjusting(null)} onDone={() => { setAdjusting(null); reload(); }} />}
      {batchesOf && <BatchesDialog product={batchesOf} onClose={() => setBatchesOf(null)} onWriteOff={(batch) => { setBatchesOf(null); setAdjusting({ product: batchesOf, batch }); }} />}
      {historyOf && <HistoryDialog product={historyOf} onClose={() => setHistoryOf(null)} />}
    </Page>
  );
}

type Mode = "opening" | "melted" | "damaged" | "expired" | "count";

function AdjustDialog({ product, batch, onClose, onDone }: { product: Product; batch?: Batch; onClose: () => void; onDone: () => void }) {
  const units = product.units.filter((u) => u.is_active);
  const [mode, setMode] = useState<Mode>(batch ? "expired" : "melted");
  const [qty, setQty] = useState(batch ? formatQtyM(batch.qty_m) : "");
  const [unitId, setUnitId] = useState((batch ? units.find((u) => u.is_base) : units.find((u) => u.is_default_sale) ?? units[0])!.id);
  const [expiry, setExpiry] = useState("");
  const [batchNo, setBatchNo] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const unit = units.find((u) => u.id === unitId)!;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = qty.trim() === "0" && mode === "count" ? 0 : parseQty(qty);
    if (q === null) return setError("Enter a quantity.");
    const baseM = q === 0 ? 0 : toBaseM(q, unit.factor_m);
    if (baseM === null || (product.qty_decimals === 0 && baseM % 1000 !== 0)) return setError(`That does not make a whole number of ${product.base_unit}.`);
    setError("");
    setBusy(true);
    try {
      const r = await api<{ on_hand_m: number }>("stock.adjust", {
        product_id: product.id, qty_m: baseM, note,
        mode: mode === "count" ? "set" : mode === "opening" ? "add" : "remove",
        reason: mode === "count" ? "adjustment" : mode,
        batch_id: mode !== "opening" && mode !== "count" ? batch?.id ?? null : null,
        expiry_date: mode === "opening" && expiry ? expiry : null, batch_no: mode === "opening" ? batchNo : null,
      });
      toast.success(`${product.name}: stock is now ${formatStock(r.on_hand_m, product.base_unit, product.units)}`);
      onDone();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} title={`Adjust stock — ${productLabel(product)}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted">In stock: <b className="num text-text">{formatStock(product.on_hand_m, product.base_unit, product.units)}</b>{batch && <> · this batch{batch.batch_no ? ` (${batch.batch_no})` : ""}: <b className="num text-text">{formatQtyM(batch.qty_m)} {product.base_unit}</b>, expiry {formatDate(batch.expiry_date)}</>}</p>
        <Field label="What happened?">{(p) => (
          <Select {...p} value={mode} onChange={(e) => { setMode(e.target.value as Mode); setError(""); }}>
            <option value="melted">Melted</option><option value="damaged">Damaged / broken</option><option value="expired">Expired</option>
            {!batch && <option value="count">I counted the stock — set the correct quantity</option>}
            {!batch && <option value="opening">Add opening stock (stock already held before using this app)</option>}
          </Select>
        )}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={mode === "count" ? "Counted quantity" : mode === "opening" ? "Quantity to add" : "Quantity lost"}>{(p) => <Input {...p} className="num" inputMode="decimal" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>
          <Field label="in">{(p) => <Select {...p} value={unitId} onChange={(e) => setUnitId(Number(e.target.value))}>{units.map((u) => <option key={u.id} value={u.id}>{u.name}{!u.is_base ? ` (${formatQtyM(u.factor_m)} ${product.base_unit})` : ""}</option>)}</Select>}</Field>
          {mode === "opening" && <>
            <Field label={product.track_expiry ? "Expiry date" : "Expiry date (optional)"}>{(p) => <Input {...p} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />}</Field>
            <Field label="Batch no (optional)">{(p) => <Input {...p} value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />}</Field>
          </>}
        </div>
        <Field label="Note" hint={mode === "melted" ? "e.g. which freezer, what happened" : undefined}>{(p) => <Input {...p} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {mode === "opening" && <p className="text-xs text-muted">For new deliveries use Purchases instead, so the supplier, cost and amount owed are recorded.</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}

function BatchesDialog({ product, onClose, onWriteOff }: { product: Product; onClose: () => void; onWriteOff: (b: Batch) => void }) {
  const q = useApi<Batch[]>("stock.batches", { product_id: product.id });
  return (
    <Dialog open onClose={onClose} wide title={`Batches — ${productLabel(product)}`}>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !q.data ? <Spinner /> : q.data.length === 0 ? <p className="py-8 text-center text-sm text-muted">No stock on hand.</p> : (
        <table className="w-full text-sm">
          <thead><tr><th className={th}>Batch</th><th className={th}>Expiry</th><th className={`${th} text-right`}>Quantity</th><th className={`${th} text-right`}>Cost / {product.base_unit}</th><th className={th} /></tr></thead>
          <tbody className="divide-y divide-border">
            {q.data.map((b) => (
              <tr key={b.id}>
                <td className={`${td} num`}>{b.batch_no ?? <span className="text-muted">—</span>}</td>
                <td className={td}>{b.expiry_date ? (b.is_expired ? <Badge tone="danger">Expired {formatDate(b.expiry_date)}</Badge> : formatDate(b.expiry_date)) : <span className="text-muted">No expiry</span>}</td>
                <td className={`${td} num text-right font-medium`}>{formatStock(b.qty_m, product.base_unit, product.units)}</td>
                <td className={`${td} num text-right text-muted`}>₹{(b.cost4 / 10000).toFixed(2)}</td>
                <td className={`${td} text-right`}><Button size="sm" onClick={() => onWriteOff(b)}>Write off</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted">Invoices take stock from the batch that expires first.</p>
    </Dialog>
  );
}

function HistoryDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const q = useApi<{ id: number; qty_m: number; reason: string; note: string | null; created_at: string; batch_no: string | null; user_name: string | null }[]>("stock.movements", { product_id: product.id });
  return (
    <Dialog open onClose={onClose} wide title={`Stock history — ${productLabel(product)}`}>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !q.data ? <Spinner /> : q.data.length === 0 ? <p className="py-8 text-center text-sm text-muted">No stock movements yet.</p> : (
        <table className="w-full text-sm">
          <thead><tr><th className={th}>When</th><th className={th}>Reason</th><th className={`${th} text-right`}>Change ({product.base_unit})</th><th className={th}>Batch</th><th className={th}>By / note</th></tr></thead>
          <tbody className="divide-y divide-border">
            {q.data.map((m) => (
              <tr key={m.id}><td className={`${td} whitespace-nowrap text-muted`}>{formatDateTime(m.created_at)}</td><td className={td}>{REASONS[m.reason] ?? m.reason}</td>
                <td className={`${td} num text-right font-medium ${m.qty_m < 0 ? "text-danger" : "text-primary"}`}>{m.qty_m > 0 ? "+" : ""}{formatQtyM(m.qty_m)}</td>
                <td className={`${td} num text-muted`}>{m.batch_no}</td><td className={`${td} text-muted`}>{[m.user_name, m.note].filter(Boolean).join(" · ")}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data?.length === 200 && <p className="mt-2 text-xs text-muted">Showing the latest 200 movements.</p>}
    </Dialog>
  );
}
