"use client";
import { Ban, Plus, Trash2, Truck } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { ProductCombo, productLabel } from "@/components/pickers";
import { Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { api, errorText, formatDate, newRef, today, useApi } from "@/lib/api";
import { formatINR, formatPaise, paiseToDecimal, parseQty, parseRupees } from "@/lib/money";
import { useShop } from "@/lib/session";
import { computeLine } from "@/lib/tax";
import { METHOD_LABELS, type Method, type Product, type Supplier } from "@/lib/types";
import { formatQtyM, toBaseM } from "@/lib/units";

interface ListRow { id: number; bill_no: string | null; bill_date: string; status: string; grand_total: number; paid_total: number; due_amount: number; supplier_name: string }
/* eslint-disable @typescript-eslint/no-explicit-any */

export default function PurchasesPage() {
  return <ManagersOnly><Purchases /></ManagersOnly>;
}

function Purchases() {
  const [range, setRange] = useState({ from: today(-90), to: today() });
  const list = useApi<ListRow[]>("purchases.list", range);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  return (
    <Page>
      <PageHeader title="Purchases" description="Enter each supplier bill. Stock, batch, expiry, cost and the amount owed are all updated together." actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-4" /> New purchase</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From">{(p) => <Input {...p} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
      </div>
      <Card className="overflow-hidden">
        {list.error ? <div className="p-4"><ErrorNote onRetry={list.reload}>{list.error}</ErrorNote></div> : !list.data ? <Spinner />
          : list.data.length === 0 ? <EmptyState icon={<Truck />} title="No purchases in this period">Enter a supplier bill to add stock.</EmptyState> : (
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Date</th><th className={th}>Supplier</th><th className={th}>Bill no</th><th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>Unpaid</th><th className={th}>Status</th></tr></thead>
              <tbody className="divide-y divide-border">
                {list.data.map((p) => (
                  <tr key={p.id} tabIndex={0} onClick={() => setOpenId(p.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(p.id)} className="cursor-pointer hover:bg-surface-2">
                    <td className={`${td} whitespace-nowrap text-muted`}>{formatDate(p.bill_date)}</td><td className={`${td} font-medium`}>{p.supplier_name}</td><td className={`${td} num`}>{p.bill_no}</td>
                    <td className={`${td} num text-right font-medium`}>{formatINR(p.grand_total)}</td><td className={`${td} num text-right`}>{p.due_amount > 0 ? <span className="text-warn">{formatINR(p.due_amount)}</span> : "—"}</td>
                    <td className={td}>{p.status === "cancelled" ? <Badge tone="danger">Cancelled</Badge> : p.due_amount === 0 ? <Badge tone="success">Paid</Badge> : <Badge tone="warn">Unpaid</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Card>
      {creating && <NewPurchase onClose={() => setCreating(false)} onSaved={() => { setCreating(false); void list.reload(); }} />}
      {openId && <PurchaseDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />}
    </Page>
  );
}

interface Row { key: string; productId: number; unitId: number; qty: string; rate: string; disc: string; gst: string; batch: string; mfg: string; expiry: string }

function NewPurchase({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { gst } = useShop();
  const products = useApi<Product[]>("products.list");
  const suppliers = useApi<Supplier[]>("suppliers.list");
  const [supplierId, setSupplierId] = useState("");
  const [billNo, setBillNo] = useState("");
  const [billDate, setBillDate] = useState(today());
  const [inclusive, setInclusive] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState<Method>("bank");
  const [reference, setReference] = useState("");
  const [billTotal, setBillTotal] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ref] = useState(newRef);
  const qtyRefs = useRef(new Map<string, HTMLInputElement>());
  const byId = useMemo(() => new Map((products.data ?? []).map((p) => [p.id, p])), [products.data]);
  const patchRow = (key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));

  const lines = rows.map((r) => {
    const product = byId.get(r.productId)!, unit = product.units.find((u) => u.id === r.unitId)!;
    const qtyM = parseQty(r.qty), rate = parseRupees(r.rate), disc = r.disc.trim() === "" ? 0 : parseRupees(r.disc), rateBp = Math.round(Number(r.gst || 0) * 100);
    const baseM = qtyM ? toBaseM(qtyM, unit.factor_m) : null;
    let err = "";
    if (qtyM === null) err = "quantity"; else if (rate === null) err = "rate"; else if (disc === null) err = "discount";
    else if (baseM === null || (product.qty_decimals === 0 && qtyM % 1000 !== 0)) err = "whole quantity";
    else if (!Number.isFinite(rateBp) || rateBp < 0 || rateBp > 10000) err = "GST %";
    else if (product.track_expiry && !r.expiry) err = "expiry date";
    const amounts = err ? null : computeLine({ qtyMilli: qtyM!, unitPricePaise: rate!, discountPaise: disc!, taxRateBp: gst ? rateBp : 0, priceIncludesTax: inclusive }, true);
    return { r, product, unit, qtyM, rate, disc, rateBp, baseM, err, amounts };
  });
  const taxable = lines.reduce((a, l) => a + (l.amounts?.taxable ?? 0), 0), tax = lines.reduce((a, l) => a + (l.amounts?.tax ?? 0), 0);
  const computed = taxable + tax;
  const printed = billTotal.trim() === "" ? null : parseRupees(billTotal);
  const roundOff = printed === null ? 0 : printed - computed;
  const grand = computed + roundOff;

  const add = (p: Product) => {
    const unit = p.units.find((u) => u.is_default_purchase && u.is_active) ?? p.units.find((u) => u.is_active)!;
    const key = newRef();
    setRows((rs) => [...rs, { key, productId: p.id, unitId: unit.id, qty: "", rate: "", disc: "", gst: String(p.tax_rate_bp / 100), batch: "", mfg: "", expiry: "" }]);
    window.setTimeout(() => qtyRefs.current.get(key)?.focus(), 40);
  };

  const save = async () => {
    if (!supplierId) return setError("Choose the supplier.");
    if (rows.length === 0) return setError("Add at least one item.");
    const bad = lines.find((l) => l.err);
    if (bad) return setError(`${productLabel(bad.product)}: enter a valid ${bad.err}.`);
    if (billTotal.trim() !== "" && printed === null) return setError("Enter a valid bill total.");
    if (Math.abs(roundOff) > 100) return setError(`The bill total differs from the items by ${formatINR(Math.abs(roundOff))}. Check the rates, discounts and GST — only a difference of up to ₹1 is accepted as rounding.`);
    const paidP = paid.trim() === "" ? 0 : parseRupees(paid);
    if (paidP === null || paidP > grand) return setError("The amount paid must be between 0 and the bill total.");
    setError("");
    setBusy(true);
    try {
      await api("purchases.create", {
        client_ref: ref, supplier_id: Number(supplierId), bill_no: billNo, bill_date: billDate, note, rates_include_tax: inclusive, round_off: roundOff,
        items: lines.map((l) => ({ product_id: l.product.id, unit_id: l.unit.id, qty_m: l.qtyM, rate: l.rate, discount: l.disc, tax_rate_bp: gst ? l.rateBp : 0, batch_no: l.r.batch, mfg_date: l.r.mfg || null, expiry_date: l.r.expiry || null })),
        paid: paidP > 0 ? { amount: paidP, method, reference } : null,
      });
      toast.success("Purchase saved and stock added");
      onSaved();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  if (!products.data || !suppliers.data) return <Dialog open onClose={onClose} title="New purchase"><Spinner /></Dialog>;
  return (
    <Dialog open onClose={() => { if (rows.length === 0 || window.confirm("Discard this purchase?")) onClose(); }} wide title="New purchase" footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save purchase</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Supplier" className="sm:col-span-2">{(p) => <Select {...p} autoFocus value={supplierId} onChange={(e) => setSupplierId(e.target.value)}><option value="">Select supplier</option>{suppliers.data!.filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
          <Field label="Supplier's bill no">{(p) => <Input {...p} className="num" value={billNo} onChange={(e) => setBillNo(e.target.value)} />}</Field>
          <Field label="Bill date">{(p) => <Input {...p} type="date" max={today()} value={billDate} onChange={(e) => setBillDate(e.target.value)} />}</Field>
        </div>
        {suppliers.data.length === 0 && <p className="text-sm text-warn">Add the supplier first, under Suppliers.</p>}
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-64 flex-1"><ProductCombo products={products.data} onPick={add} showPrice={false} /></div>
          {gst && <Checkbox label="Rates on this bill include GST" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} />}
        </div>
        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-xs text-muted uppercase"><tr>
                <th className="px-2 py-2 text-left">Product</th><th className="px-2 py-2 text-left">Unit</th><th className="px-2 py-2 text-right">Qty</th><th className="px-2 py-2 text-right">Rate ₹</th><th className="px-2 py-2 text-right">Disc ₹</th>
                {gst && <th className="px-2 py-2 text-right">GST %</th>}<th className="px-2 py-2 text-left">Batch</th><th className="px-2 py-2 text-left">Expiry</th><th className="px-2 py-2 text-right">Amount</th><th />
              </tr></thead>
              <tbody className="divide-y divide-border">
                {lines.map((l) => (
                  <tr key={l.r.key}>
                    <td className="px-2 py-1.5"><div className="font-medium">{productLabel(l.product)}</div>{l.baseM !== null && l.unit.factor_m !== 1000 && <div className="num text-xs text-muted">= {formatQtyM(l.baseM)} {l.product.base_unit}</div>}</td>
                    <td className="px-2 py-1.5"><Select aria-label="Unit" className="h-9 w-28" value={l.r.unitId} onChange={(e) => patchRow(l.r.key, { unitId: Number(e.target.value) })}>{l.product.units.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></td>
                    <td className="px-2 py-1.5"><Input ref={(el) => { if (el) qtyRefs.current.set(l.r.key, el); }} aria-label={`Quantity of ${l.product.name}`} className="num h-9 w-20 text-right" inputMode="decimal" value={l.r.qty} onChange={(e) => patchRow(l.r.key, { qty: e.target.value })} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Rate of ${l.product.name}`} className="num h-9 w-24 text-right" inputMode="decimal" value={l.r.rate} onChange={(e) => patchRow(l.r.key, { rate: e.target.value })} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Discount on ${l.product.name}`} className="num h-9 w-20 text-right" inputMode="decimal" placeholder="0" value={l.r.disc} onChange={(e) => patchRow(l.r.key, { disc: e.target.value })} /></td>
                    {gst && <td className="px-2 py-1.5"><Input aria-label={`GST percent for ${l.product.name}`} className="num h-9 w-16 text-right" inputMode="decimal" value={l.r.gst} onChange={(e) => patchRow(l.r.key, { gst: e.target.value })} /></td>}
                    <td className="px-2 py-1.5"><Input aria-label={`Batch number of ${l.product.name}`} className="num h-9 w-24" value={l.r.batch} onChange={(e) => patchRow(l.r.key, { batch: e.target.value })} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Expiry date of ${l.product.name}`} type="date" className="h-9 w-36" aria-invalid={!!l.product.track_expiry && !l.r.expiry} value={l.r.expiry} onChange={(e) => patchRow(l.r.key, { expiry: e.target.value })} /></td>
                    <td className="num px-2 py-1.5 text-right font-medium">{l.amounts ? formatPaise(l.amounts.total) : "—"}</td>
                    <td className="px-1"><button aria-label={`Remove ${l.product.name}`} onClick={() => setRows((rs) => rs.filter((r) => r.key !== l.r.key))} className="rounded p-2 text-muted hover:bg-danger-soft hover:text-danger"><Trash2 className="size-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Paid now (₹)" hint="Leave empty if the bill is on credit.">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder="0.00" value={paid} onChange={(e) => setPaid(e.target.value)} />}</Field>
            <Field label="Paid by">{(p) => <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as Method)}>{Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
            <Field label="Reference">{(p) => <Input {...p} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
            <Field label="Note" className="sm:col-span-3">{(p) => <Input {...p} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </div>
          <dl className="num grid grid-cols-[auto_auto] items-center gap-x-6 gap-y-1 self-start text-sm">
            <dt className="text-muted">Taxable</dt><dd className="text-right">{formatPaise(taxable)}</dd>
            {gst && <><dt className="text-muted">GST</dt><dd className="text-right">{formatPaise(tax)}</dd></>}
            <dt className="text-muted"><label htmlFor="bill-total">Total on supplier&apos;s bill</label></dt>
            <dd className="text-right"><input id="bill-total" className="h-7 w-28 rounded border border-border bg-surface px-2 text-right" inputMode="decimal" placeholder={paiseToDecimal(computed)} value={billTotal} onChange={(e) => setBillTotal(e.target.value)} /></dd>
            {roundOff !== 0 && <><dt className="text-muted">Round off</dt><dd className="text-right">{formatPaise(roundOff)}</dd></>}
            <dt className="font-semibold">Total</dt><dd className="text-right text-lg font-semibold">{formatINR(grand)}</dd>
          </dl>
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function PurchaseDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const q = useApi<any>("purchases.get", { id });
  const [cancelling, setCancelling] = useState(false);
  const p = q.data;
  return (
    <Dialog open onClose={onClose} wide title={p ? `Purchase — ${p.supplier_name}` : "Purchase"} footer={p?.status === "completed" && <Button className="text-danger" onClick={() => setCancelling(true)}><Ban className="size-4" /> Cancel purchase</Button>}>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !p ? <Spinner /> : (
        <div className="space-y-3 text-sm">
          {p.status === "cancelled" && <p className="rounded-md bg-danger-soft px-3 py-2 text-danger">Cancelled — {p.cancel_reason}</p>}
          <p className="text-muted">Bill <b className="num text-text">{p.bill_no ?? "—"}</b> dated {formatDate(p.bill_date)} · entered by {p.user_name}{p.note && <> · {p.note}</>}</p>
          <table className="w-full">
            <thead><tr><th className={th}>Product</th><th className={`${th} text-right`}>Quantity</th><th className={`${th} text-right`}>Rate</th><th className={`${th} text-right`}>GST</th><th className={th}>Batch / expiry</th><th className={`${th} text-right`}>Amount</th></tr></thead>
            <tbody className="divide-y divide-border">{p.items.map((i: any) => (
              <tr key={i.id}><td className={td}>{i.name}</td><td className={`${td} num text-right`}>{formatQtyM(i.qty_m)} {i.unit_name}</td><td className={`${td} num text-right`}>{formatPaise(i.rate)}</td><td className={`${td} num text-right text-muted`}>{i.tax_rate_bp / 100}%</td>
                <td className={`${td} num text-muted`}>{[i.batch_no, i.expiry_date && `exp ${formatDate(i.expiry_date)}`].filter(Boolean).join(" · ")}</td><td className={`${td} num text-right font-medium`}>{formatPaise(i.line_total)}</td></tr>
            ))}</tbody>
          </table>
          <p className="num text-right">Taxable {formatPaise(p.taxable_total)} · GST {formatPaise(p.tax_total)} · <b>Total {formatINR(p.grand_total)}</b> · Paid {formatINR(p.paid_total)} · <span className={p.due_amount > 0 ? "text-warn" : ""}>Unpaid {formatINR(p.due_amount)}</span></p>
        </div>
      )}
      <ConfirmDialog open={cancelling} danger title="Cancel this purchase?" confirmLabel="Cancel purchase" reasonLabel="Reason (required)" onClose={() => setCancelling(false)}
        message="Its stock is removed and the amount owed to the supplier is reversed. This is only possible while none of that stock has been sold or adjusted."
        onConfirm={async (reason) => { try { await api("purchases.cancel", { id, reason }); toast.success("Purchase cancelled"); setCancelling(false); await q.reload(); onChanged(); } catch (e) { toast.error(errorText(e)); } }} />
    </Dialog>
  );
}
