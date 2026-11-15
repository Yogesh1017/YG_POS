"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { Boxes, History, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { Badge, Button, Card, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/invoice";
import { formatINR, parseRupees } from "@/lib/money";
import { useShop } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Product, StockReason } from "@/lib/types";
import { unwrap, useQuery } from "@/lib/use-query";

const REASON_LABELS: Record<StockReason, string> = {
  opening: "Opening stock", stock_in: "Stock received", sale: "Sale", sale_cancel: "Bill cancelled", sale_return: "Customer return",
  adjustment: "Count correction", damage: "Damaged", expiry: "Expired",
};

export default function InventoryPage() {
  return <ManagersOnly><Inventory /></ManagersOnly>;
}

function Inventory() {
  const { business } = useShop();
  const products = useLiveQuery(() => db.products.where("business_id").equals(business.id).and((p) => p.track_stock && p.is_active).toArray(), [business.id]);
  const [filter, setFilter] = useState<"all" | "low" | "out">("all");
  const [q, setQ] = useState("");
  const [adjusting, setAdjusting] = useState<Product | null>(null);
  const [history, setHistory] = useState<Product | null>(null);

  const stats = useMemo(() => {
    const list = products ?? [];
    return {
      // value in paise: stock (3 dp) × cost (2 dp), whole-number arithmetic
      value: list.reduce((a, p) => a + (p.stock_qty > 0 ? Math.round((Math.round(p.stock_qty * 1000) * Math.round(p.purchase_price * 100)) / 1000) : 0), 0),
      low: list.filter((p) => p.stock_qty > 0 && p.stock_qty <= p.low_stock_threshold).length,
      out: list.filter((p) => p.stock_qty <= 0).length,
    };
  }, [products]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => (!s || p.name.toLowerCase().includes(s) || p.sku?.toLowerCase().includes(s) || p.barcode?.includes(s)) &&
        (filter === "all" || (filter === "out" ? p.stock_qty <= 0 : p.stock_qty > 0 && p.stock_qty <= p.low_stock_threshold)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, q, filter]);

  if (!products) return <Spinner />;
  return (
    <Page>
      <PageHeader title="Stock" description="Stock goes down with every bill and back up on cancellations and returns. Record deliveries, damage and count corrections here." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card className="p-4"><div className="text-xs text-muted">Stock value at cost</div><div className="num mt-1 text-xl font-semibold">{formatINR(stats.value)}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted">Running low</div><div className="num mt-1 text-xl font-semibold text-warn">{stats.low}</div></Card>
        <Card className="p-4"><div className="text-xs text-muted">Out of stock</div><div className="num mt-1 text-xl font-semibold text-danger">{stats.out}</div></Card>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search products" aria-label="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-44" aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All tracked products</option><option value="low">Running low</option><option value="out">Out of stock</option>
        </Select>
      </div>
      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState icon={<Boxes />} title={products.length === 0 ? "No stock-tracked products" : "Nothing matches"}>{products.length === 0 ? "Add products with “Track stock” turned on to see them here." : "Try a different search or filter."}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/60"><tr>
                <th className={th}>Product</th><th className={`${th} text-right`}>In stock</th><th className={`${th} text-right`}>Warn at</th><th className={`${th} text-right`}>Value at cost</th><th className={th}><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className={td}><span className="font-medium">{p.name}</span> {p.stock_qty <= 0 ? <Badge tone="danger">Out</Badge> : p.stock_qty <= p.low_stock_threshold ? <Badge tone="warn">Low</Badge> : null}</td>
                    <td className={`${td} num text-right font-medium`}>{p.stock_qty} <span className="text-xs font-normal text-muted">{p.unit}</span></td>
                    <td className={`${td} num text-right text-muted`}>{p.low_stock_threshold}</td>
                    <td className={`${td} num text-right text-muted`}>{formatINR(p.stock_qty > 0 ? Math.round(p.stock_qty * p.purchase_price * 100) : 0)}</td>
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <Button size="sm" onClick={() => setAdjusting(p)}><SlidersHorizontal className="size-4" /> Adjust</Button>{" "}
                      <Button size="sm" variant="ghost" aria-label={`Stock history of ${p.name}`} onClick={() => setHistory(p)}><History className="size-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adjusting && <AdjustDialog product={adjusting} onClose={() => setAdjusting(null)} />}
      {history && <HistoryDialog product={history} onClose={() => setHistory(null)} />}
    </Page>
  );
}

type Mode = "stock_in" | "damage" | "expiry" | "count";

function AdjustDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("stock_in");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(qty);
    if (qty.trim() === "" || !Number.isFinite(n) || n < 0 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) return setError("Enter a valid quantity (up to 3 decimals).");
    let change: number;
    if (mode === "count") change = Math.round(n * 1000 - Math.round(product.stock_qty * 1000)) / 1000;
    else if (n === 0) return setError("Enter a quantity above 0.");
    else change = mode === "stock_in" ? n : -n;
    if (change === 0) return setError("That is the same as the current stock — nothing to change.");
    const unitCost = mode === "stock_in" && cost.trim() !== "" ? parseRupees(cost) : null;
    if (mode === "stock_in" && cost.trim() !== "" && unitCost === null) return setError("Enter a valid cost price.");
    setError("");
    setBusy(true);
    const { data, error: err } = await supabase().rpc("adjust_stock", {
      p_product_id: product.id, p_qty_change: change, p_reason: mode === "count" ? "adjustment" : mode,
      p_note: note, p_unit_cost: unitCost === null ? null : unitCost / 100,
    });
    setBusy(false);
    if (err) return setError(errorMessage(err));
    await db.products.update(product.id, { stock_qty: Number(data), ...(unitCost !== null ? { purchase_price: unitCost / 100 } : {}) });
    toast.success(`${product.name}: stock is now ${Number(data)} ${product.unit}`);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} title={`Adjust stock — ${product.name}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted">Currently in stock: <b className="num text-text">{product.stock_qty} {product.unit}</b></p>
        <Field label="What happened?">{(p) => (
          <Select {...p} value={mode} onChange={(e) => { setMode(e.target.value as Mode); setError(""); }}>
            <option value="stock_in">Received new stock</option><option value="damage">Damaged / broken</option>
            <option value="expiry">Expired</option><option value="count">I counted — set the correct quantity</option>
          </Select>
        )}</Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label={mode === "count" ? `Counted quantity (${product.unit})` : mode === "stock_in" ? `Quantity received (${product.unit})` : `Quantity to remove (${product.unit})`}>
            {(p) => <Input {...p} className="num" type="number" min={0} step="0.001" inputMode="decimal" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />}
          </Field>
          {mode === "stock_in" && <Field label="Cost per unit (₹, optional)" hint="Updates the product's cost price">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder={String(product.purchase_price)} value={cost} onChange={(e) => setCost(e.target.value)} />}</Field>}
        </div>
        <Field label="Note (optional)">{(p) => <Input {...p} maxLength={200} placeholder={mode === "stock_in" ? "Supplier, bill number…" : ""} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}

function HistoryDialog({ product, onClose }: { product: Product; onClose: () => void }) {
  const q = useQuery(async () => unwrap(await supabase().from("stock_movements").select("id, qty_change, reason, note, created_at").eq("product_id", product.id).order("created_at", { ascending: false }).limit(100)) as { id: string; qty_change: number; reason: StockReason; note: string | null; created_at: string }[], [product.id]);
  return (
    <Dialog open onClose={onClose} wide title={`Stock history — ${product.name}`}>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !q.data ? <Spinner /> : q.data.length === 0 ? <p className="py-8 text-center text-sm text-muted">No stock movements yet.</p> : (
        <table className="w-full text-sm">
          <thead><tr><th className={th}>When</th><th className={th}>Reason</th><th className={`${th} text-right`}>Change</th><th className={th}>Note</th></tr></thead>
          <tbody className="divide-y divide-border">
            {q.data.map((m) => (
              <tr key={m.id}><td className={`${td} whitespace-nowrap text-muted`}>{formatDateTime(m.created_at)}</td><td className={td}>{REASON_LABELS[m.reason]}</td>
                <td className={`${td} num text-right font-medium ${m.qty_change < 0 ? "text-danger" : "text-primary"}`}>{m.qty_change > 0 ? "+" : ""}{m.qty_change}</td><td className={`${td} text-muted`}>{m.note}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data?.length === 100 && <p className="mt-2 text-xs text-muted">Showing the latest 100 movements.</p>}
    </Dialog>
  );
}
