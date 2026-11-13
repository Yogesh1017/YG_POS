"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { Minus, PackageSearch, Pencil, Plus, Printer, Search, ShoppingCart, Trash2, UserRound, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CustomerPicker } from "@/components/customer-picker";
import { PrintJob, usePaper } from "@/components/receipt";
import { Badge, Button, Dialog, EmptyState, Field, Input, Select, Spinner, cn } from "@/components/ui";
import { CheckoutError, recordSale } from "@/lib/checkout";
import { db } from "@/lib/db";
import { PAYMENT_LABELS, billRef } from "@/lib/invoice";
import { formatINR, formatPaise, formatQty, paiseToDecimal, parseQty, parseRupees } from "@/lib/money";
import { useShop } from "@/lib/session";
import { syncNow, useSyncStore } from "@/lib/sync";
import { lineGross } from "@/lib/tax";
import type { LocalSale, PaymentMethod, Product } from "@/lib/types";
import { billDiscountOf, computeCart, useCart, type CartLine } from "@/stores/cart";

const MAX_TILES = 150;

export default function PosPage() {
  const { business, member, canManage } = useShop();
  const products = useLiveQuery(() => db.products.where("business_id").equals(business.id).toArray(), [business.id]);
  const categories = useLiveQuery(() => db.categories.where("business_id").equals(business.id).sortBy("name"), [business.id]) ?? [];
  const lastSyncedAt = useSyncStore((s) => s.lastSyncedAt);
  const cart = useCart();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [view, setView] = useState<"items" | "cart">("items");
  const [paying, setPaying] = useState(false);
  const [editing, setEditing] = useState<CartLine | null>(null);
  const [pickingCustomer, setPickingCustomer] = useState(false);
  const [doneId, setDoneId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const billDiscount = billDiscountOf(cart.lines, cart.billDiscountPaise, cart.billDiscountPctBp);
  const { totals } = useMemo(
    () => computeCart(cart.lines, billDiscount, business, cart.customer),
    [cart.lines, billDiscount, business, cart.customer],
  );

  const active = useMemo(() => (products ?? []).filter((p) => p.is_active).sort((a, b) => a.name.localeCompare(b.name)), [products]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active.filter((p) =>
      (!category || p.category_id === category) &&
      (!q || p.name.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q) || p.barcode?.includes(q)));
  }, [active, query, category]);

  const add = useCallback((p: Product) => {
    cart.addProduct(p);
    setQuery("");
    searchRef.current?.focus();
  }, [cart]);

  // Enter in the search box: a scanned barcode / typed SKU adds the item straight away.
  const onSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    const exact = active.find((p) => p.barcode === q || p.sku?.toLowerCase() === q.toLowerCase());
    if (exact) return add(exact);
    if (filtered.length === 1) return add(filtered[0]);
    toast.error(filtered.length === 0 ? `Nothing matches "${q}"` : "More than one match — pick the item");
  };

  // Keyboard: F2 search, F9 pay. Typing (or a barcode scanner) anywhere lands in the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return; }
      if (e.key === "F9") { e.preventDefault(); if (useCart.getState().lines.length) setPaying(true); return; }
      const t = e.target as HTMLElement;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!products) return <Spinner />;

  const itemCount = cart.lines.length;
  const catalogEmpty = active.length === 0;

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* ------------------------------------------------ items */}
      <section className={cn("min-h-0 flex-1 flex-col lg:flex", view === "items" ? "flex" : "hidden")} aria-label="Products">
        <div className="space-y-2 border-b border-border bg-surface p-3">
          <form onSubmit={onSearchSubmit} className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input ref={searchRef} autoFocus value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products or scan barcode"
              placeholder="Search name / SKU, or scan barcode  (F2)" className="h-11 pl-9 text-base" autoComplete="off" enterKeyHint="search" />
            {query && <button type="button" onClick={() => { setQuery(""); searchRef.current?.focus(); }} aria-label="Clear search" className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1.5 text-muted hover:bg-surface-2"><X className="size-4" /></button>}
          </form>
          {categories.length > 0 && (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="tablist" aria-label="Categories">
              {[{ id: "", name: "All" }, ...categories].map((c) => (
                <button key={c.id} role="tab" aria-selected={category === c.id} onClick={() => setCategory(c.id)} className={cn(
                  "h-8 shrink-0 rounded-full border px-3 text-sm font-medium",
                  category === c.id ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface hover:bg-surface-2",
                )}>{c.name}</button>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {catalogEmpty ? (
            <EmptyState icon={<PackageSearch />} title={lastSyncedAt ? "No products yet" : "Loading your products…"}
              action={lastSyncedAt && canManage ? <Link href="/products/" className="font-medium text-primary hover:underline">Add your first product</Link> : undefined}>
              {lastSyncedAt ? (canManage ? "Add products to start billing." : "Ask the owner to add products.") : "Products are downloaded to this device the first time, so billing keeps working offline."}
            </EmptyState>
          ) : filtered.length === 0 ? (
            <EmptyState icon={<PackageSearch />} title="No matching products">Try a different name, SKU or barcode.</EmptyState>
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {filtered.slice(0, MAX_TILES).map((p) => {
                  const out = p.track_stock && p.stock_qty <= 0;
                  const low = p.track_stock && !out && p.stock_qty <= p.low_stock_threshold;
                  return (
                    <li key={p.id}>
                      <button onClick={() => add(p)} className="flex h-full min-h-[5.25rem] w-full flex-col justify-between gap-2 rounded-lg border border-border bg-surface p-2.5 text-left transition-colors hover:border-primary active:bg-primary-soft">
                        <span className="line-clamp-2 text-sm leading-snug font-medium">{p.name}</span>
                        <span className="flex items-end justify-between gap-2">
                          <span className="num font-semibold">{formatINR(Math.round(p.sale_price * 100))}</span>
                          {p.track_stock && <Badge tone={out ? "danger" : low ? "warn" : "neutral"}>{out ? "Out" : `${p.stock_qty} ${p.unit}`}</Badge>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {filtered.length > MAX_TILES && <p className="mt-3 text-center text-xs text-muted">Showing the first {MAX_TILES} of {filtered.length}. Search to narrow down.</p>}
            </>
          )}
        </div>
      </section>

      {/* ------------------------------------------------ cart */}
      <section className={cn("min-h-0 flex-1 flex-col border-border bg-surface lg:flex lg:w-[26rem] lg:flex-none lg:border-l", view === "cart" ? "flex" : "hidden")} aria-label="Current bill">
        <button onClick={() => setPickingCustomer(true)} className="flex items-center gap-2.5 border-b border-border px-4 py-3 text-left hover:bg-surface-2">
          <UserRound className="size-4 text-muted" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{cart.customer?.name || "Walk-in customer"}</span>
            {cart.customer?.phone && <span className="num block text-xs text-muted">{cart.customer.phone}</span>}
          </span>
          <span className="text-xs font-medium text-primary">{cart.customer ? "Change" : "Add"}</span>
        </button>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {itemCount === 0 ? (
            <EmptyState icon={<ShoppingCart />} title="Bill is empty">Tap a product or scan a barcode to start.</EmptyState>
          ) : (
            <ul className="divide-y divide-border">
              {cart.lines.map((l, i) => {
                const step = l.qtyMilli % 1000 === 0 ? 1000 : 0;
                return (
                  <li key={l.productId} className="px-4 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <button onClick={() => setEditing(l)} className="min-w-0 text-left" title="Edit quantity, price or discount">
                        <span className="block truncate text-sm font-medium">{l.name}</span>
                        <span className="num text-xs text-muted">
                          {formatPaise(l.unitPricePaise)} / {l.unit}
                          {totals.lines[i].discount > 0 && <span className="text-primary"> · −{formatPaise(totals.lines[i].discount)}</span>}
                          <Pencil className="ml-1.5 inline size-3" aria-hidden />
                        </span>
                      </button>
                      <span className="num text-sm font-semibold">{formatPaise(totals.lines[i].total)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <button aria-label={`Decrease ${l.name}`} onClick={() => (l.qtyMilli > 1000 ? cart.setQty(l.productId, l.qtyMilli - 1000) : cart.remove(l.productId))} className="flex size-8 items-center justify-center rounded-md border border-border hover:bg-surface-2"><Minus className="size-3.5" /></button>
                        <button onClick={() => setEditing(l)} className="num h-8 min-w-12 rounded-md border border-border px-2 text-sm font-medium hover:bg-surface-2" aria-label={`Quantity of ${l.name}`}>{formatQty(l.qtyMilli)}</button>
                        <button aria-label={`Increase ${l.name}`} onClick={() => cart.setQty(l.productId, l.qtyMilli + (step || 1000))} className="flex size-8 items-center justify-center rounded-md border border-border hover:bg-surface-2"><Plus className="size-3.5" /></button>
                      </div>
                      <button aria-label={`Remove ${l.name}`} onClick={() => cart.remove(l.productId)} className="rounded-md p-2 text-muted hover:bg-danger-soft hover:text-danger"><Trash2 className="size-4" /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {itemCount > 0 && (
          <div className="space-y-1.5 border-t border-border px-4 py-3 text-sm">
            <BillDiscount />
            {totals.discount > 0 && <Row label="Discount" value={`−${formatPaise(totals.discount)}`} />}
            {business.gst_registered && <Row label="Taxable value" value={formatPaise(totals.taxable)} />}
            {business.gst_registered && <Row label="GST" value={formatPaise(totals.tax)} />}
            {totals.roundOff !== 0 && <Row label="Round off" value={formatPaise(totals.roundOff)} />}
          </div>
        )}
        <div className="border-t border-border p-3">
          <div className="mb-2.5 flex items-baseline justify-between px-1">
            <span className="text-sm text-muted">{itemCount} item{itemCount === 1 ? "" : "s"}</span>
            <span className="num text-3xl font-semibold tracking-tight" aria-label="Bill total">{formatINR(totals.grand)}</span>
          </div>
          <div className="flex gap-2">
            <Button size="lg" disabled={itemCount === 0} onClick={() => { if (window.confirm("Clear this bill?")) cart.clear(); }} aria-label="Clear bill"><Trash2 className="size-4" /></Button>
            <Button size="lg" variant="primary" className="flex-1" disabled={itemCount === 0} onClick={() => setPaying(true)}>Take payment <kbd className="ml-1 rounded bg-black/15 px-1.5 text-xs">F9</kbd></Button>
          </div>
        </div>
      </section>

      {/* phone: switch between items and bill */}
      <nav className="grid grid-cols-2 border-t border-border bg-surface lg:hidden">
        <button onClick={() => setView("items")} className={cn("py-3 text-sm font-medium", view === "items" && "text-primary")}>Products</button>
        <button onClick={() => setView("cart")} className={cn("py-3 text-sm font-medium", view === "cart" && "text-primary")}>Bill · {itemCount} · <span className="num">{formatINR(totals.grand)}</span></button>
      </nav>

      {editing && <LineEditor line={editing} onClose={() => setEditing(null)} />}
      <CustomerPicker open={pickingCustomer} onClose={() => setPickingCustomer(false)} />
      {paying && (
        <PaymentDialog grand={totals.grand} onClose={() => setPaying(false)} onPaid={(sale) => {
          setPaying(false);
          setDoneId(sale.id);
          setView("items");
          void syncNow(business.id);
        }} cashier={member.display_name} />
      )}
      {doneId && <SaleDone saleId={doneId} onClose={() => { setDoneId(null); searchRef.current?.focus(); }} />}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-muted"><span>{label}</span><span className="num">{value}</span></div>;
}

/** Bill-level discount: type "50" for ₹50 off or "10%" for ten percent off. */
function BillDiscount() {
  const cart = useCart();
  const current = cart.billDiscountPctBp ? `${cart.billDiscountPctBp / 100}%` : cart.billDiscountPaise ? paiseToDecimal(cart.billDiscountPaise) : "";
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);
  const apply = () => {
    const t = text.trim();
    if (t === "") return cart.setBillDiscount(0);
    if (t.endsWith("%")) {
      const pct = Number(t.slice(0, -1));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) { toast.error("Discount must be between 0% and 100%"); return setText(current); }
      return cart.setBillDiscountPct(Math.round(pct * 100));
    }
    const paise = parseRupees(t);
    if (paise === null) { toast.error("Enter an amount like 50 or a percentage like 10%"); return setText(current); }
    cart.setBillDiscount(paise);
  };
  return (
    <label className="flex items-center justify-between gap-3 text-muted">
      <span>Bill discount</span>
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={apply} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        placeholder="₹ or %" inputMode="decimal" className="num h-8 w-24 rounded-md border border-border bg-surface px-2 text-right text-sm text-text" />
    </label>
  );
}

function LineEditor({ line, onClose }: { line: CartLine; onClose: () => void }) {
  const cart = useCart();
  const [qty, setQty] = useState(formatQty(line.qtyMilli));
  const [price, setPrice] = useState(paiseToDecimal(line.unitPricePaise));
  const [discount, setDiscount] = useState(line.discountPaise ? paiseToDecimal(line.discountPaise) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = (e: FormEvent) => {
    e.preventDefault();
    const q = parseQty(qty), p = parseRupees(price), d = discount.trim() === "" ? 0 : parseRupees(discount);
    const errs: Record<string, string> = {};
    if (q === null) errs.qty = "Enter a quantity above 0 (up to 3 decimals)";
    if (p === null) errs.price = "Enter a valid price";
    if (d === null) errs.discount = "Enter a valid amount";
    if (q !== null && p !== null && d !== null && d > lineGross(q, p)) errs.discount = "Discount is more than the line amount";
    if (Object.keys(errs).length) return setErrors(errs);
    cart.setQty(line.productId, q!);
    cart.setPrice(line.productId, p!);
    cart.setLineDiscount(line.productId, d!);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title={line.name}>
      <form onSubmit={save} className="grid grid-cols-2 gap-4" noValidate>
        <Field label={`Quantity (${line.unit})`} error={errors.qty}>{(p) => <Input {...p} className="num" inputMode="decimal" autoFocus onFocus={(e) => e.target.select()} value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>
        <Field label={`Price per ${line.unit} (₹)`} error={errors.price}>{(p) => <Input {...p} className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
        <Field label="Discount on this item (₹)" error={errors.discount} className="col-span-2">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder="0.00" value={discount} onChange={(e) => setDiscount(e.target.value)} />}</Field>
        <div className="col-span-2 flex justify-between">
          <Button variant="ghost" className="text-danger" onClick={() => { cart.remove(line.productId); onClose(); }}><Trash2 className="size-4" /> Remove</Button>
          <Button type="submit" variant="primary">Update</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface PayRow { method: PaymentMethod; amount: string; reference: string }

function PaymentDialog({ grand, cashier, onClose, onPaid }: { grand: number; cashier: string; onClose: () => void; onPaid: (sale: LocalSale) => void }) {
  const { business } = useShop();
  const cart = useCart();
  const [rows, setRows] = useState<PayRow[]>([{ method: "cash", amount: paiseToDecimal(grand), reference: "" }]);
  const [tendered, setTendered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const amounts = rows.map((r) => (r.amount.trim() === "" ? 0 : parseRupees(r.amount)));
  const invalid = amounts.some((a) => a === null);
  const paid = amounts.reduce<number>((a, v) => a + (v ?? 0), 0);
  const due = grand - paid;
  const cash = rows.reduce((a, r, i) => a + (r.method === "cash" ? amounts[i] ?? 0 : 0), 0);
  const tenderedPaise = tendered.trim() === "" ? null : parseRupees(tendered);
  const change = tenderedPaise !== null && tenderedPaise > cash ? tenderedPaise - cash : 0;
  const hasCustomer = !!cart.customer?.id;

  const setRow = (i: number, patch: Partial<PayRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const payAll = (method: PaymentMethod) => { setRows([{ method, amount: paiseToDecimal(grand), reference: "" }]); setTendered(""); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return setError("Check the payment amounts.");
    if (due < 0) return setError("Payments add up to more than the bill. For cash, enter the bill amount here and the cash handed over below.");
    if (due > 0 && !hasCustomer) return setError("This leaves a balance due. Select a saved customer to sell on credit, or collect the full amount.");
    if (tenderedPaise !== null && tenderedPaise < cash) return setError("Cash handed over is less than the cash amount.");
    setError("");
    setBusy(true);
    try {
      const sale = await recordSale({
        business, cashier, lines: cart.lines,
        billDiscountPaise: billDiscountOf(cart.lines, cart.billDiscountPaise, cart.billDiscountPctBp),
        customer: cart.customer, note: cart.note,
        payments: rows.map((r, i) => ({ method: r.method, amountPaise: amounts[i] ?? 0, reference: r.reference })),
        tenderedPaise: tenderedPaise ?? undefined,
      });
      cart.clear();
      onPaid(sale);
    } catch (err) {
      console.error(err);
      setError(err instanceof CheckoutError ? err.message : "Could not save this bill on the device. Free up storage space and try again — the bill has NOT been recorded.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Take payment">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div className="flex items-baseline justify-between rounded-lg bg-surface-2 px-4 py-3">
          <span className="text-sm text-muted">To collect</span>
          <span className="num text-3xl font-semibold">{formatINR(grand)}</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {(["cash", "upi", "card"] as const).map((m) => (
            <Button key={m} onClick={() => payAll(m)} variant={rows.length === 1 && rows[0].method === m && due === 0 ? "primary" : "secondary"}>{PAYMENT_LABELS[m]}</Button>
          ))}
          <Button onClick={() => { setRows([{ method: "cash", amount: "0", reference: "" }]); setTendered(""); }} disabled={!hasCustomer} title={hasCustomer ? "Add the whole bill to the customer's dues" : "Select a saved customer first"}>Credit</Button>
        </div>
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Select aria-label="Payment method" value={r.method} onChange={(e) => setRow(i, { method: e.target.value as PaymentMethod })} className="w-28">
                {Object.entries(PAYMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
              <Input aria-label="Amount" className="num flex-1 text-right" inputMode="decimal" value={r.amount} onFocus={(e) => e.target.select()} onChange={(e) => setRow(i, { amount: e.target.value })} aria-invalid={amounts[i] === null} autoFocus={i === 0} />
              {r.method !== "cash" && <Input aria-label="Reference" placeholder="Ref / UTR (optional)" className="w-36" maxLength={80} value={r.reference} onChange={(e) => setRow(i, { reference: e.target.value })} />}
              {rows.length > 1 && <Button aria-label="Remove payment" variant="ghost" className="px-2.5" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}><X className="size-4" /></Button>}
            </div>
          ))}
          {rows.length < 4 && (
            <Button size="sm" variant="ghost" onClick={() => setRows((rs) => [...rs, { method: rs.some((r) => r.method === "upi") ? "card" : "upi", amount: paiseToDecimal(Math.max(due, 0)), reference: "" }])}>
              <Plus className="size-4" /> Split payment
            </Button>
          )}
        </div>
        {cash > 0 && (
          <div className="flex items-end gap-3">
            <Field label="Cash handed over (optional)" className="flex-1">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder={paiseToDecimal(cash)} value={tendered} onChange={(e) => setTendered(e.target.value)} />}</Field>
            <div className="pb-2 text-sm">Change: <span className="num text-lg font-semibold">{formatINR(change)}</span></div>
          </div>
        )}
        {due > 0 && (
          <p className={cn("rounded-md px-3 py-2 text-sm", hasCustomer ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger")}>
            {hasCustomer ? <>Balance of <b className="num">{formatINR(due)}</b> will be added to {cart.customer?.name}&apos;s dues.</> : <>Balance of <b className="num">{formatINR(due)}</b> is not covered.</>}
          </p>
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>Back</Button>
          <Button type="submit" variant="primary" size="lg" loading={busy}>Save bill</Button>
        </div>
      </form>
    </Dialog>
  );
}

function SaleDone({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const { business } = useShop();
  const sale = useLiveQuery(() => db.sales.get(saleId), [saleId]);
  const [paper] = usePaper();
  const [printing, setPrinting] = useState(false);
  const donePrinting = useCallback(() => setPrinting(false), []);
  if (!sale) return null;
  const inv = sale.invoice;
  return (
    <Dialog open onClose={onClose} title="Bill saved" footer={
      <>
        <Button onClick={() => setPrinting(true)}><Printer className="size-4" /> Print bill</Button>
        <Button variant="primary" onClick={onClose} autoFocus>New bill</Button>
      </>
    }>
      <div className="space-y-3 text-center">
        <div className="num text-4xl font-semibold">{formatINR(inv.totals.grand)}</div>
        <div className="text-sm text-muted">
          {sale.status === "synced" ? <>Invoice <b className="num text-text">{sale.invoice_no}</b></> :
            sale.status === "failed" ? <span className="text-danger">Saved on this device, but the server rejected it: {sale.error}. Open sync status (bottom of the menu).</span> :
            <>Ref <b className="num text-text">{billRef(sale.id)}</b> · saved on this device, uploading when online</>}
        </div>
        {inv.changePaise ? <div className="rounded-lg bg-primary-soft px-4 py-3 text-primary">Return change <b className="num text-2xl">{formatINR(inv.changePaise)}</b></div> : null}
        {inv.duePaise > 0 && <div className="rounded-lg bg-warn-soft px-4 py-2 text-sm text-warn">Added to {inv.customer.name}&apos;s dues: <b className="num">{formatINR(inv.duePaise)}</b></div>}
      </div>
      {printing && <PrintJob business={business} invoice={inv} paper={paper} onDone={donePrinting} />}
    </Dialog>
  );
}
