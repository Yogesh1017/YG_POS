"use client";
import { ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Combo, ProductCombo, productLabel } from "@/components/pickers";
import { SalePrintButtons } from "@/components/sale-actions";
import { Badge, Button, Dialog, Field, Input, Select, Spinner, cn } from "@/components/ui";
import { ApiError, api, errorText, formatDate, newRef, useApi } from "@/lib/api";
import { formatINR, formatPaise, paiseToDecimal, parseQty, parseRupees } from "@/lib/money";
import { resolvePrice, type PriceSource } from "@/lib/pricing";
import { useShop } from "@/lib/session";
import { computeSale, distributeDiscount, lineGross, type LineInput } from "@/lib/tax";
import { METHOD_LABELS, type Customer, type Method, type Product, type Sale, type Unit } from "@/lib/types";
import { formatQtyM, formatStock, toBaseM } from "@/lib/units";

interface Row { key: string; productId: number; unitId: number; qty: string; rate: string | null; disc: string }
interface Pay { method: Method; amount: string; reference: string }
interface Draft { customerId: number | null; cashName: string; rows: Row[]; billDisc: string; note: string; pays: Pay[]; payTouched: boolean; ref: string }
const emptyDraft = (): Draft => ({ customerId: null, cashName: "", rows: [], billDisc: "", note: "", pays: [{ method: "cash", amount: "", reference: "" }], payTouched: false, ref: newRef() });
const DRAFT_KEY = "ygpos-invoice-draft";
const SOURCE_LABEL: Record<PriceSource, string> = { list: "List", tier: "Qty price", customer: "Customer price", manual: "Manual" };
interface Problem { type: "price" | "stock" | "credit"; message: string }

export default function BillingPage() {
  const { settings, gst, canManage } = useShop();
  const products = useApi<Product[]>("products.list");
  const customers = useApi<Customer[]>("customers.list");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [approval, setApproval] = useState<{ problems: Problem[]; needsManager: boolean } | null>(null);
  const [saved, setSaved] = useState<Sale | null>(null);
  const [addingCustomer, setAddingCustomer] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef(new Map<string, HTMLInputElement>());
  /** Where the cursor should go after the next render: "customer", "search", or a line's key (its quantity box). */
  const focusNext = useRef<string | null>(null);

  // The invoice being written survives a refresh or the app being closed by mistake.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) setDraft({ ...emptyDraft(), ...(JSON.parse(raw) as Draft) });
    } catch { /* start fresh */ }
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); }, [draft, loaded]);
  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p })), []);
  const patchRow = (key: string, p: Partial<Row>) => setDraft((d) => ({ ...d, rows: d.rows.map((r) => (r.key === key ? { ...r, ...p } : r)) }));

  const customer = customers.data?.find((c) => c.id === draft.customerId) ?? null;
  const special = useApi<{ unit_id: number; price: number }[]>(customer ? "customers.prices" : null, { customer_id: customer?.id });
  const recent = useApi<{ last_prices: { unit_id: number; unit_price: number; sold_on: string }[]; sales: { id: number; invoice_no: string; sold_on: string; grand_total: number }[] }>(customer ? "customers.recent" : null, { customer_id: customer?.id });
  const specialByUnit = useMemo(() => new Map((customer ? special.data ?? [] : []).map((s) => [s.unit_id, s.price])), [special.data, customer]);
  const lastByUnit = useMemo(() => new Map((customer ? recent.data?.last_prices ?? [] : []).map((s) => [s.unit_id, s])), [recent.data, customer]);
  const productById = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);
  const interstate = gst && !!customer?.state_code && !!settings.state_code && customer.state_code !== settings.state_code;

  // ---- price and total every line exactly as the core will
  const lines = draft.rows.map((r) => {
    const product = productById.get(r.productId);
    const unit = product?.units.find((u) => u.id === r.unitId);
    const qtyM = parseQty(r.qty);
    const rule = unit && qtyM ? resolvePrice(unit.sale_price, unit.tiers, specialByUnit.get(unit.id), qtyM) : null;
    const typed = r.rate === null ? null : parseRupees(r.rate);
    const rate = r.rate === null ? rule?.price ?? unit?.sale_price ?? 0 : typed;
    const manual = r.rate !== null && typed !== null && rule !== null && typed !== rule.price;
    const disc = r.disc.trim() === "" ? 0 : parseRupees(r.disc);
    const baseM = unit && qtyM ? toBaseM(qtyM, unit.factor_m) : null;
    let error = "";
    if (!product || !unit) error = "This product is no longer available";
    else if (qtyM === null) error = "Enter a quantity";
    else if (product.qty_decimals === 0 && qtyM % 1000 !== 0) error = `Whole ${unit.name} only`;
    else if (baseM === null) error = "Quantity does not convert to whole units";
    else if (rate === null) error = "Enter a valid rate";
    else if (disc === null) error = "Enter a valid discount";
    else if (disc > lineGross(qtyM, rate)) error = "Discount is more than the amount";
    return { r, product, unit, qtyM: qtyM ?? 0, rate: rate ?? 0, disc: disc ?? 0, baseM: baseM ?? 0, manual, source: (manual ? "manual" : rule?.source ?? "list") as PriceSource, rulePrice: rule?.price ?? 0, error };
  });
  const valid = lines.filter((l) => !l.error);
  const afterLine = valid.map((l) => lineGross(l.qtyM, l.rate) - l.disc);
  const afterLineTotal = afterLine.reduce((a, b) => a + b, 0);
  const billDiscText = draft.billDisc.trim();
  const billDisc = billDiscText === "" ? 0 : billDiscText.endsWith("%")
    ? (Number.isFinite(Number(billDiscText.slice(0, -1))) ? Math.round((afterLineTotal * Math.min(Math.max(Number(billDiscText.slice(0, -1)), 0), 100)) / 100) : null)
    : parseRupees(billDiscText);
  const shares = distributeDiscount(afterLine, Math.min(billDisc ?? 0, afterLineTotal));
  const inputs: LineInput[] = valid.map((l, i) => ({ qtyMilli: l.qtyM, unitPricePaise: l.rate, discountPaise: l.disc + shares[i], taxRateBp: gst ? l.product!.tax_rate_bp : 0, priceIncludesTax: !!l.product!.price_includes_tax }));
  const totals = computeSale(inputs, { interstate, roundOff: !!settings.round_off_total });

  // Stock needed per product across all lines, to warn before saving.
  const needByProduct = new Map<number, number>();
  for (const l of valid) needByProduct.set(l.product!.id, (needByProduct.get(l.product!.id) ?? 0) + l.baseM);

  const payAmounts = draft.pays.map((p) => (p.amount.trim() === "" ? 0 : parseRupees(p.amount)));
  // A cash sale is paid in full unless the amount was changed; a customer's bill starts as credit.
  const autoPaid = !draft.payTouched && !customer ? totals.grand : null;
  const paid = autoPaid ?? payAmounts.reduce<number>((a, v) => a + (v ?? 0), 0);
  const due = totals.grand - paid;
  const overLimit = customer && customer.credit_limit !== null && due > 0 && customer.balance + due > customer.credit_limit;

  // ---- actions
  const addProduct = (p: Product) => {
    const unit = p.units.find((u) => u.is_default_sale && u.is_active) ?? p.units.find((u) => u.is_active);
    if (!unit) return void toast.error(`${p.name} has no active unit`);
    const existing = draft.rows.find((r) => r.productId === p.id && r.unitId === unit.id);
    const key = existing?.key ?? newRef();
    if (!existing) setDraft((d) => ({ ...d, rows: [...d.rows, { key, productId: p.id, unitId: unit.id, qty: "1", rate: null, disc: "" }] }));
    focusNext.current = key;
  };
  // Focus moves right after the screen has updated — never on a timer, so a fast typist cannot outrun it.
  useEffect(() => {
    const want = focusNext.current;
    if (!want || document.querySelector("dialog[open]")) return;
    const el = want === "customer" ? customerRef.current : want === "search" ? searchRef.current : qtyRefs.current.get(want);
    if (el) { el.focus(); el.select(); focusNext.current = null; }
  });

  const reset = () => { focusNext.current = "customer"; setDraft(emptyDraft()); setApproval(null); };

  const save = async (approved: string[] = [], approver?: { username: string; password: string }) => {
    if (saving) return;
    if (draft.rows.length === 0) return void toast.error("Add at least one item.");
    const bad = lines.find((l) => l.error);
    if (bad) return void toast.error(`${bad.product ? productLabel(bad.product) : "A line"}: ${bad.error}`);
    if (billDisc === null) return void toast.error("Enter the bill discount as an amount (50) or a percentage (5%).");
    if (payAmounts.some((a) => a === null)) return void toast.error("Check the amount received.");
    if (due < 0) return void toast.error("The amount received is more than the bill total.");
    if (due > 0 && !customer) return void toast.error("A cash sale must be paid in full. Select a customer to sell on credit.");
    // An owner/manager who typed a rate has, by doing so, approved it.
    const auto = canManage && lines.some((l) => l.manual) ? ["price"] : [];
    setSaving(true);
    try {
      const sale = await api<Sale>("sales.create", {
        client_ref: draft.ref, customer_id: customer?.id ?? null, cash_customer_name: customer ? null : draft.cashName, note: draft.note,
        bill_discount: Math.min(billDisc, afterLineTotal),
        items: lines.map((l) => ({ product_id: l.product!.id, unit_id: l.unit!.id, qty_m: l.qtyM, unit_price: l.rate, discount: l.disc })),
        payments: autoPaid !== null ? (autoPaid > 0 ? [{ method: draft.pays[0].method, amount: autoPaid, reference: draft.pays[0].reference }] : [])
          : draft.pays.map((p, i) => ({ method: p.method, amount: payAmounts[i] ?? 0, reference: p.reference })).filter((p) => p.amount > 0),
        approved: [...new Set([...auto, ...approved])], approver,
      });
      setApproval(null);
      setSaved(sale);
      setDraft(emptyDraft());
      void products.reload();
      void customers.reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "needs_approval") {
        const d = e.data as { problems: Problem[]; needs_manager: boolean };
        setApproval({ problems: d.problems, needsManager: d.needs_manager });
      } else toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "F3") { e.preventDefault(); customerRef.current?.focus(); }
      else if (e.key === "F9" || (e.key === "Enter" && e.ctrlKey)) { e.preventDefault(); void saveRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!products.data || !customers.data || !loaded) return <Spinner />;
  const activeCustomers = customers.data.filter((c) => c.is_active);

  return (
    <div className="flex h-full flex-col">
      {/* ---------------- customer + product entry */}
      <div className="grid gap-3 border-b border-border bg-surface p-3 lg:grid-cols-[22rem_1fr]">
        <div>
          {customer ? (
            <div className="flex h-10 items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 text-sm">
              <span className="min-w-0 truncate"><span className="font-semibold">{customer.name}</span>{customer.phone && <span className="num text-muted"> · {customer.phone}</span>}</span>
              <button aria-label="Change customer" title="Change customer (F3)" onClick={() => { focusNext.current = "customer"; patch({ customerId: null, payTouched: false }); }} className="rounded p-1 text-muted hover:bg-surface"><X className="size-4" /></button>
            </div>
          ) : (
            <Combo items={activeCustomers} keyOf={(c) => c.id} inputRef={customerRef} autoFocus label="Select customer" placeholder="Customer — type shop name or phone  (F3)"
              text={(c) => [c.name, c.contact_person, c.phone, c.city].filter(Boolean).join(" ")}
              onPick={(c) => { focusNext.current = "search"; patch({ customerId: c.id, payTouched: false }); }}
              render={(c) => <span className="flex justify-between gap-3"><span><span className="font-medium">{c.name}</span>{c.city && <span className="text-muted"> · {c.city}</span>}</span>{c.balance > 0 && <span className="num text-xs text-warn">owes {formatINR(c.balance)}</span>}</span>}
              footer={(q, close) => <Button size="sm" variant="ghost" onClick={() => { close(); setAddingCustomer(q); }}><UserPlus className="size-4" /> New customer{q ? ` “${q}”` : ""}</Button>} />
          )}
          <div className="mt-1.5 min-h-5 text-xs text-muted">
            {customer ? (
              <span className="num">
                Balance <b className={customer.balance > 0 ? "text-warn" : "text-text"}>{formatINR(customer.balance)}</b>
                {customer.credit_limit !== null && <> · limit {formatINR(customer.credit_limit)}</>}
                {customer.gstin && <> · GSTIN {customer.gstin}</>}{interstate && <> · <b className="text-text">IGST (other state)</b></>}
                {recent.data?.sales[0] && <> · last bill {recent.data.sales[0].invoice_no}, {formatDate(recent.data.sales[0].sold_on)}, {formatINR(recent.data.sales[0].grand_total)}</>}
              </span>
            ) : (
              <label className="flex items-center gap-2">Cash sale — name on bill (optional)
                <input value={draft.cashName} onChange={(e) => patch({ cashName: e.target.value })} maxLength={120} aria-label="Name on bill" className="h-6 flex-1 rounded border border-border bg-surface px-1.5 text-text" />
              </label>
            )}
          </div>
        </div>
        <ProductCombo products={products.data} onPick={addProduct} inputRef={searchRef} />
      </div>

      {/* ---------------- lines */}
      <div className="min-h-0 flex-1 overflow-auto">
        {draft.rows.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-muted">
            <p className="font-medium text-text">New invoice</p>
            <p className="mt-1">Pick the customer, then type a product name and press Enter. Enter the quantity and press Enter again for the next item.</p>
            <p className="mt-3 text-xs">F2 products · F3 customer · F9 save · Tab moves between quantity, rate and discount</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 border-b border-border bg-surface-2 text-xs text-muted uppercase">
              <tr>
                <th className="w-8 px-2 py-2 text-left">#</th><th className="px-2 py-2 text-left">Product</th><th className="w-32 px-2 py-2 text-left">Unit</th>
                <th className="w-24 px-2 py-2 text-right">Qty</th><th className="w-32 px-2 py-2 text-right">Rate ₹</th><th className="w-24 px-2 py-2 text-right">Disc ₹</th>
                <th className="w-32 px-2 py-2 text-right">Amount</th><th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((l, i) => {
                const short = l.product && !l.error && (needByProduct.get(l.product.id) ?? 0) > Math.max(l.product.sellable_m, 0);
                const last = l.unit ? lastByUnit.get(l.unit.id) : undefined;
                const amount = l.error ? 0 : lineGross(l.qtyM, l.rate) - l.disc;
                return (
                  <tr key={l.r.key} className={cn(l.error && "bg-danger-soft/40")}>
                    <td className="num px-2 py-1.5 text-muted">{i + 1}</td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{l.product ? productLabel(l.product) : "Unknown product"}</div>
                      <div className="num text-xs text-muted">
                        {l.product && <span className={short ? "font-medium text-danger" : ""}>Stock {formatStock(l.product.sellable_m, l.product.base_unit, l.product.units)}{short && " — not enough"}</span>}
                        {l.unit && l.baseM > 0 && l.unit.factor_m !== 1000 && <> · = {formatQtyM(l.baseM)} {l.product!.base_unit}</>}
                        {l.error && <span className="text-danger"> · {l.error}</span>}
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <Select aria-label={`Unit for line ${i + 1}`} className="h-9" value={l.r.unitId} onChange={(e) => patchRow(l.r.key, { unitId: Number(e.target.value), rate: null })}>
                        {(l.product?.units ?? []).filter((u: Unit) => u.is_active || u.id === l.r.unitId).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </Select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input ref={(el) => { if (el) qtyRefs.current.set(l.r.key, el); else qtyRefs.current.delete(l.r.key); }} aria-label={`Quantity for line ${i + 1}`} inputMode="decimal"
                        className="num h-9 text-right" value={l.r.qty} onFocus={(e) => e.target.select()} onChange={(e) => patchRow(l.r.key, { qty: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchRef.current?.focus(); } }} />
                    </td>
                    <td className="px-2 py-1.5">
                      <Input aria-label={`Rate for line ${i + 1}`} inputMode="decimal" className={cn("num h-9 text-right", l.manual && "border-warn")} onFocus={(e) => e.target.select()}
                        value={l.r.rate ?? paiseToDecimal(l.rate)} onChange={(e) => patchRow(l.r.key, { rate: e.target.value })}
                        onBlur={() => { if (l.r.rate !== null && !l.manual) patchRow(l.r.key, { rate: null }); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchRef.current?.focus(); } }} />
                      <div className="mt-0.5 flex justify-end gap-1 text-[11px] text-muted">
                        {l.manual ? <button className="text-warn underline" onClick={() => patchRow(l.r.key, { rate: null })} title="Back to the normal rate">Manual · reset to {formatPaise(l.rulePrice)}</button> : l.source !== "list" && <span className="text-primary">{SOURCE_LABEL[l.source]}</span>}
                        {last && !l.manual && last.unit_price !== l.rate && <span title={`Last sold on ${formatDate(last.sold_on)}`}>last {formatPaise(last.unit_price)}</span>}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 align-top">
                      <Input aria-label={`Discount for line ${i + 1}`} inputMode="decimal" placeholder="0" className="num h-9 text-right" value={l.r.disc} onFocus={(e) => e.target.select()} onChange={(e) => patchRow(l.r.key, { disc: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); searchRef.current?.focus(); } }} />
                    </td>
                    <td className="num px-2 py-1.5 text-right align-top font-semibold leading-9">{formatPaise(amount)}</td>
                    <td className="px-1 py-1.5 align-top"><button tabIndex={-1} aria-label={`Remove line ${i + 1}`} onClick={() => setDraft((d) => ({ ...d, rows: d.rows.filter((r) => r.key !== l.r.key) }))} className="rounded-md p-2 text-muted hover:bg-danger-soft hover:text-danger"><Trash2 className="size-4" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ---------------- totals and payment */}
      <div className="grid gap-x-6 gap-y-3 border-t border-border bg-surface p-3 lg:grid-cols-[1fr_auto_18rem]">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-20 text-muted">Received</span>
            {draft.pays.map((p, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <Input aria-label="Amount received" inputMode="decimal" className="num h-9 w-28 text-right" placeholder="0.00" onFocus={(e) => e.target.select()}
                  value={autoPaid !== null && i === 0 ? paiseToDecimal(autoPaid) : p.amount}
                  onChange={(e) => patch({ payTouched: true, pays: draft.pays.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)) })} />
                <Select aria-label="Payment method" className="h-9 w-32" value={p.method} onChange={(e) => patch({ pays: draft.pays.map((x, j) => (j === i ? { ...x, method: e.target.value as Method } : x)) })}>
                  {Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                {p.method !== "cash" && <Input aria-label="Payment reference" placeholder="Ref / cheque no" className="h-9 w-32" maxLength={80} value={p.reference} onChange={(e) => patch({ pays: draft.pays.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)) })} />}
                {draft.pays.length > 1 && <button aria-label="Remove payment" onClick={() => patch({ pays: draft.pays.filter((_, j) => j !== i) })} className="rounded p-1 text-muted hover:bg-surface-2"><X className="size-4" /></button>}
              </span>
            ))}
            <Button size="sm" variant="ghost" onClick={() => patch({ payTouched: true, pays: [{ ...draft.pays[0], amount: paiseToDecimal(totals.grand) }] })}>Full</Button>
            {customer && <Button size="sm" variant="ghost" onClick={() => patch({ payTouched: true, pays: [{ ...draft.pays[0], amount: "" }] })}>Credit</Button>}
            {draft.pays.length < 3 && <Button size="sm" variant="ghost" onClick={() => patch({ payTouched: true, pays: [...draft.pays.map((p, i) => (i === 0 && autoPaid !== null ? { ...p, amount: paiseToDecimal(autoPaid) } : p)), { method: "upi", amount: "", reference: "" }] })}>+ Split</Button>}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="w-20 text-muted">Note</span>
            <Input aria-label="Note on invoice" className="h-9 max-w-md" maxLength={300} placeholder="Printed on the invoice (optional)" value={draft.note} onChange={(e) => patch({ note: e.target.value })} />
          </div>
          {due > 0 && customer && <p className={cn("text-sm", overLimit ? "font-medium text-danger" : "text-warn")}>
            {formatINR(due)} will be added to {customer.name}&apos;s balance (then {formatINR(customer.balance + due)}).{overLimit && " This is over their credit limit and needs owner/manager approval."}
          </p>}
        </div>
        <dl className="num grid grid-cols-[auto_auto] items-center gap-x-6 gap-y-0.5 self-start text-sm">
          <dt className="text-muted">Items / gross</dt><dd className="text-right">{draft.rows.length} / {formatPaise(totals.gross)}</dd>
          <dt className="text-muted"><label htmlFor="bill-disc">Bill discount</label></dt>
          <dd className="text-right"><input id="bill-disc" value={draft.billDisc} onChange={(e) => patch({ billDisc: e.target.value })} placeholder="₹ or %" inputMode="decimal" aria-invalid={billDisc === null} className="h-7 w-24 rounded border border-border bg-surface px-2 text-right aria-[invalid=true]:border-danger" /></dd>
          {totals.discount > 0 && <><dt className="text-muted">Total discount</dt><dd className="text-right">−{formatPaise(totals.discount)}</dd></>}
          <dt className="text-muted">{gst ? "Taxable" : "Sub total"}</dt><dd className="text-right">{formatPaise(totals.taxable)}</dd>
          {gst && <><dt className="text-muted">{interstate ? "IGST" : "CGST + SGST"}</dt><dd className="text-right">{formatPaise(totals.tax)}</dd></>}
          {totals.roundOff !== 0 && <><dt className="text-muted">Round off</dt><dd className="text-right">{formatPaise(totals.roundOff)}</dd></>}
        </dl>
        <div className="flex flex-col justify-between gap-2">
          <div className="text-right">
            <div className="num text-3xl font-semibold tracking-tight" aria-label="Invoice total">{formatINR(totals.grand)}</div>
            <div className="num text-sm text-muted">{due > 0 ? <>Balance due <b className="text-warn">{formatINR(due)}</b></> : due === 0 && totals.grand > 0 ? "Paid in full" : " "}</div>
          </div>
          <div className="flex gap-2">
            <Button disabled={draft.rows.length === 0 && !customer} onClick={() => { if (draft.rows.length === 0 || window.confirm("Discard this invoice?")) reset(); }}>Clear</Button>
            <Button variant="primary" size="lg" className="flex-1" loading={saving} disabled={draft.rows.length === 0} onClick={() => void save()}>Save invoice <kbd className="ml-1 rounded bg-black/15 px-1.5 text-xs">F9</kbd></Button>
          </div>
        </div>
      </div>

      {approval && <ApprovalDialog {...approval} busy={saving} onClose={() => setApproval(null)} onApprove={(approver) => void save(approval.problems.map((p) => p.type), approver)} />}
      {saved && (
        <Dialog open onClose={() => { setSaved(null); reset(); }} title="Invoice saved" footer={<><SalePrintButtons sale={saved} autoFocus /><Button onClick={() => { setSaved(null); reset(); }}>New invoice</Button></>}>
          <div className="space-y-2 text-center">
            <div className="num text-lg font-semibold">{saved.invoice_no}</div>
            <div className="text-sm text-muted">{saved.customer_name ?? "Cash sale"}</div>
            <div className="num text-4xl font-semibold">{formatINR(saved.grand_total)}</div>
            <div className="text-sm">{saved.due_amount > 0 ? <Badge tone="warn">Balance due {formatINR(saved.due_amount)}</Badge> : <Badge tone="success">Paid in full</Badge>}</div>
          </div>
        </Dialog>
      )}
      {addingCustomer !== null && <QuickCustomer initial={addingCustomer} onClose={() => setAddingCustomer(null)} onSaved={async (c) => { await customers.reload(); focusNext.current = "search"; patch({ customerId: c.id, payTouched: false }); setAddingCustomer(null); }} />}
    </div>
  );
}

/** Lists what is unusual about the bill and asks for confirmation — with an owner/manager's password if a cashier is billing. */
function ApprovalDialog({ problems, needsManager, busy, onClose, onApprove }: { problems: Problem[]; needsManager: boolean; busy: boolean; onClose: () => void; onApprove: (approver?: { username: string; password: string }) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const TITLES = { price: "Rate changed by hand", stock: "More than the stock on record", credit: "Over the credit limit" };
  const submit = (e: FormEvent) => { e.preventDefault(); onApprove(needsManager ? { username, password } : undefined); };
  return (
    <Dialog open onClose={onClose} title="Approval needed">
      <form onSubmit={submit} className="space-y-4 text-sm">
        <ul className="space-y-2">
          {problems.map((p, i) => <li key={i} className="rounded-md bg-warn-soft px-3 py-2 text-warn"><b>{TITLES[p.type]}:</b> {p.message}</li>)}
        </ul>
        {needsManager ? (
          <>
            <p className="text-muted">An owner or manager must approve this invoice with their own login.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Owner/manager username">{(p) => <Input {...p} autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
              <Field label="Their password">{(p) => <Input {...p} type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            </div>
          </>
        ) : <p className="text-muted">Saving records your approval in the audit log.</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Go back</Button><Button type="submit" variant="primary" loading={busy} autoFocus={!needsManager}><ShieldCheck className="size-4" /> Approve and save</Button></div>
      </form>
    </Dialog>
  );
}

function QuickCustomer({ initial, onClose, onSaved }: { initial: string; onClose: () => void; onSaved: (c: Customer) => Promise<void> }) {
  const isPhone = /^[0-9+ -]{6,}$/.test(initial);
  const [name, setName] = useState(isPhone ? "" : initial);
  const [phone, setPhone] = useState(isPhone ? initial : "");
  const [gstin, setGstin] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await onSaved(await api<Customer>("customers.save", { name, phone, gstin })); }
    catch (err) { toast.error(errorText(err)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="New customer">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Shop / business name" className="sm:col-span-2">{(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Phone">{(p) => <Input {...p} inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}</Field>
        <Field label="GSTIN (optional)">{(p) => <Input {...p} className="num uppercase" maxLength={15} value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} />}</Field>
        <p className="text-xs text-muted sm:col-span-2">Address, credit limit and special prices can be added later under Customers.</p>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save and select</Button></div>
      </form>
    </Dialog>
  );
}
