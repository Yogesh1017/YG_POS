"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { Ban, Printer, ReceiptText, Undo2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Page } from "@/components/app-shell";
import { PrintJob, Receipt, usePaper } from "@/components/receipt";
import { Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { db } from "@/lib/db";
import { PAYMENT_LABELS, billRef, formatDateTime, invoiceFromServer, istDate } from "@/lib/invoice";
import { formatINR, formatQty, parseQty, qtyToMilli, rupeesToPaise } from "@/lib/money";
import { useShop } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import { syncNow } from "@/lib/sync";
import type { InvoiceData, PaymentMethod } from "@/lib/types";
import { unwrap, useQuery } from "@/lib/use-query";

const PAGE_SIZE = 50;
/* eslint-disable @typescript-eslint/no-explicit-any */

export default function SalesPage() {
  const { business } = useShop();
  const [from, setFrom] = useState(istDate(-6));
  const [to, setTo] = useState(istDate());
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState({ from: istDate(-6), to: istDate(), search: "" });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [localOpen, setLocalOpen] = useState<InvoiceData | null>(null);

  const local = useLiveQuery(() => db.sales.where("business_id").equals(business.id).and((s) => s.status !== "synced").reverse().sortBy("sold_at"), [business.id]) ?? [];

  const sales = useQuery(async () => {
    let q = supabase().from("sales")
      .select("id, invoice_no, status, sold_at, customer_name, grand_total, paid_total, due_amount, returned_total", { count: "exact" })
      .eq("business_id", business.id)
      .gte("sold_at", `${applied.from}T00:00:00+05:30`).lte("sold_at", `${applied.to}T23:59:59.999+05:30`)
      .order("sold_at", { ascending: false }).limit(limit);
    const s = applied.search.trim().replace(/[%,()]/g, "");
    if (s) q = q.or(`invoice_no.ilike.%${s}%,customer_name.ilike.%${s}%,customer_phone.ilike.%${s}%`);
    const res = await q;
    if (res.error) throw res.error;
    return { rows: res.data as any[], count: res.count ?? 0 };
  }, [business.id, applied, limit]);

  return (
    <Page>
      <PageHeader title="Sales" description="Every bill, newest first. Open one to reprint, cancel or take a return." />
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (from > to) return toast.error("The start date is after the end date"); setLimit(PAGE_SIZE); setApplied({ from, to, search }); }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} max={istDate()} onChange={(e) => setTo(e.target.value)} />}</Field>
        <Field label="Search" className="min-w-48 flex-1">{(p) => <Input {...p} placeholder="Invoice no, customer name or phone" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
        <Button type="submit" variant="primary">Show</Button>
      </form>

      {local.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <div className="border-b border-border bg-warn-soft px-4 py-2 text-sm font-medium text-warn">On this device, not yet uploaded ({local.length})</div>
          <ul className="divide-y divide-border">
            {local.map((s) => (
              <li key={s.id}>
                <button onClick={() => setLocalOpen(s.invoice)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-2">
                  <span className="num">{billRef(s.id)} <span className="text-muted">· {formatDateTime(s.sold_at)}</span> {s.status === "failed" && <Badge tone="danger">rejected</Badge>}</span>
                  <span className="num font-medium">{formatINR(s.invoice.totals.grand)}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="overflow-hidden">
        {sales.error ? <div className="p-4"><ErrorNote onRetry={sales.reload}>{sales.error}</ErrorNote></div>
          : !sales.data ? <Spinner />
          : sales.data.rows.length === 0 ? <EmptyState icon={<ReceiptText />} title="No bills in this period">Change the dates or search, or make a sale from Billing.</EmptyState>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2/60"><tr>
                  <th className={th}>Invoice</th><th className={th}>Date</th><th className={th}>Customer</th>
                  <th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>Due</th><th className={th}>Status</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {sales.data.rows.map((s) => (
                    <tr key={s.id} onClick={() => setOpenId(s.id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setOpenId(s.id)} className="cursor-pointer hover:bg-surface-2">
                      <td className={`${td} num font-medium`}>{s.invoice_no}</td>
                      <td className={`${td} whitespace-nowrap text-muted`}>{formatDateTime(s.sold_at)}</td>
                      <td className={td}>{s.customer_name ?? <span className="text-muted">Walk-in</span>}</td>
                      <td className={`${td} num text-right font-medium`}>{formatINR(rupeesToPaise(s.grand_total))}</td>
                      <td className={`${td} num text-right`}>{s.due_amount > 0 ? <span className="text-warn">{formatINR(rupeesToPaise(s.due_amount))}</span> : "—"}</td>
                      <td className={td}>{s.status === "cancelled" ? <Badge tone="danger">Cancelled</Badge> : s.returned_total > 0 ? <Badge tone="warn">Returned {formatINR(rupeesToPaise(s.returned_total))}</Badge> : <Badge tone="success">Paid{s.due_amount > 0 ? " in part" : ""}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted">
                <span>Showing {sales.data.rows.length} of {sales.data.count}</span>
                {sales.data.rows.length < sales.data.count && <Button size="sm" loading={sales.loading} onClick={() => setLimit((l) => l + PAGE_SIZE)}>Load more</Button>}
              </div>
            </div>
          )}
      </Card>

      {openId && <SaleDetail saleId={openId} onClose={() => setOpenId(null)} onChanged={() => { void sales.reload(); void syncNow(business.id); }} />}
      {localOpen && <LocalBill invoice={localOpen} onClose={() => setLocalOpen(null)} />}
    </Page>
  );
}

function LocalBill({ invoice, onClose }: { invoice: InvoiceData; onClose: () => void }) {
  const { business } = useShop();
  const [paper] = usePaper();
  const [printing, setPrinting] = useState(false);
  const done = useCallback(() => setPrinting(false), []);
  return (
    <Dialog open onClose={onClose} title={`Bill ${billRef(invoice.id)}`} wide footer={<Button variant="primary" onClick={() => setPrinting(true)}><Printer className="size-4" /> Print</Button>}>
      <div className="overflow-x-auto rounded-lg bg-white p-3 text-black"><Receipt business={business} invoice={invoice} paper={paper} /></div>
      {printing && <PrintJob business={business} invoice={invoice} paper={paper} onDone={done} />}
    </Dialog>
  );
}

function SaleDetail({ saleId, onClose, onChanged }: { saleId: string; onClose: () => void; onChanged: () => void }) {
  const { business, canManage } = useShop();
  const [paper] = usePaper();
  const [printing, setPrinting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const done = useCallback(() => setPrinting(false), []);

  const q = useQuery(async () => {
    const sale = unwrap(await supabase().from("sales").select("*, sale_items(*), payments(*), sale_returns(*)").eq("id", saleId).single()) as any;
    const members = unwrap(await supabase().from("business_members").select("user_id, display_name").eq("business_id", business.id)) as any[];
    return { sale, cashier: members.find((m) => m.user_id === sale.created_by)?.display_name ?? null };
  }, [saleId]);

  const sale = q.data?.sale;
  const invoice = sale ? invoiceFromServer(sale, q.data!.cashier) : null;
  const canReturn = sale?.status === "completed" && sale.sale_items.some((i: any) => i.returned_qty < i.qty);
  const refunds = (sale?.payments ?? []).filter((p: any) => p.kind === "refund");

  return (
    <Dialog open onClose={onClose} wide title={sale ? `Invoice ${sale.invoice_no}` : "Invoice"} footer={sale && (
      <>
        {canManage && sale.status === "completed" && sale.sale_returns.length === 0 && <Button onClick={() => setCancelling(true)} className="text-danger"><Ban className="size-4" /> Cancel bill</Button>}
        {canManage && canReturn && <Button onClick={() => setReturning(true)}><Undo2 className="size-4" /> Return items</Button>}
        <Button variant="primary" onClick={() => setPrinting(true)}><Printer className="size-4" /> Print</Button>
      </>
    )}>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !sale || !invoice ? <Spinner /> : (
        <div className="space-y-4">
          {sale.status === "cancelled" && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">Cancelled on {formatDateTime(sale.cancelled_at)} — {sale.cancel_reason}</p>}
          {sale.sale_returns.map((r: any) => (
            <p key={r.id} className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
              Return <b className="num">{r.credit_note_no}</b> on {formatDateTime(r.created_at)}: goods worth <b className="num">{formatINR(rupeesToPaise(r.total))}</b>
              {r.refund_paid > 0 && <> · refunded <span className="num">{formatINR(rupeesToPaise(r.refund_paid))}</span></>}
              {r.due_reduced > 0 && <> · dues reduced by <span className="num">{formatINR(rupeesToPaise(r.due_reduced))}</span></>}
              {r.reason && <> · {r.reason}</>}
            </p>
          ))}
          {refunds.length > 0 && sale.status === "cancelled" && <p className="text-sm text-muted">Refunded: {refunds.map((p: any) => `${PAYMENT_LABELS[p.method as PaymentMethod]} ${formatINR(rupeesToPaise(p.amount))}`).join(", ")}</p>}
          <div className="overflow-x-auto rounded-lg bg-white p-3 text-black"><Receipt business={business} invoice={invoice} paper={paper} /></div>
        </div>
      )}
      {printing && invoice && <PrintJob business={business} invoice={invoice} paper={paper} onDone={done} />}
      <ConfirmDialog open={cancelling} danger title="Cancel this bill?" confirmLabel="Cancel bill" reasonLabel="Reason (required)" onClose={() => setCancelling(false)}
        message={<>The items go back into stock, any amount due is removed, and money received is recorded as refunded. The invoice number stays in your records as cancelled. This cannot be undone.</>}
        onConfirm={async (reason) => {
          const { error } = await supabase().rpc("cancel_sale", { p_sale_id: saleId, p_reason: reason });
          if (error) { toast.error(errorMessage(error)); return; }
          toast.success("Bill cancelled");
          setCancelling(false);
          await q.reload();
          onChanged();
        }} />
      {returning && sale && <ReturnDialog sale={sale} onClose={() => setReturning(false)} onDone={async () => { setReturning(false); await q.reload(); onChanged(); }} />}
    </Dialog>
  );
}

function ReturnDialog({ sale, onClose, onDone }: { sale: any; onClose: () => void; onDone: () => Promise<void> }) {
  const items = [...sale.sale_items].sort((a: any, b: any) => a.line_no - b.line_no).filter((i: any) => i.returned_qty < i.qty);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState(true);
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One id per dialog: a retry after a lost response cannot create a second return.
  const [returnId] = useState(() => crypto.randomUUID());

  const submit = async () => {
    const lines: { sale_item_id: string; qty: string }[] = [];
    for (const i of items) {
      const t = (qty[i.id] ?? "").trim();
      if (!t) continue;
      const m = parseQty(t);
      const left = qtyToMilli(i.qty) - qtyToMilli(i.returned_qty);
      if (m === null || m > left) return setError(`"${i.name}": enter a quantity up to ${formatQty(left)}`);
      lines.push({ sale_item_id: i.id, qty: (m / 1000).toFixed(3) });
    }
    if (lines.length === 0) return setError("Enter the quantity being returned for at least one item.");
    setError("");
    setBusy(true);
    const { data, error: err } = await supabase().rpc("create_return", { p: { id: returnId, sale_id: sale.id, items: lines, restock, refund_method: method, reason } });
    setBusy(false);
    if (err) return setError(errorMessage(err));
    toast.success(`Return ${data.credit_note_no} recorded` + (data.refund_paid > 0 ? ` — refund ${formatINR(rupeesToPaise(data.refund_paid))}` : ""));
    await onDone();
  };

  return (
    <Dialog open onClose={onClose} title="Return items" footer={<><Button onClick={onClose} disabled={busy}>Back</Button><Button variant="primary" loading={busy} onClick={submit}>Record return</Button></>}>
      <div className="space-y-4 text-sm">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((i: any) => {
            const left = qtyToMilli(i.qty) - qtyToMilli(i.returned_qty);
            return (
              <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span><span className="font-medium">{i.name}</span><span className="block text-xs text-muted">Sold {i.qty} {i.unit}{i.returned_qty > 0 ? `, ${i.returned_qty} already returned` : ""}</span></span>
                <span className="flex items-center gap-2">
                  <Input aria-label={`Quantity of ${i.name} to return`} className="num h-9 w-20 text-right" inputMode="decimal" placeholder="0" value={qty[i.id] ?? ""} onChange={(e) => setQty((s) => ({ ...s, [i.id]: e.target.value }))} />
                  <Button size="sm" variant="ghost" onClick={() => setQty((s) => ({ ...s, [i.id]: formatQty(left) }))}>All</Button>
                </span>
              </li>
            );
          })}
        </ul>
        <Checkbox label="Put the returned items back into stock" hint="Untick for damaged goods that cannot be sold again." checked={restock} onChange={(e) => setRestock(e.target.checked)} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Refund paid by" hint="Unpaid dues on this bill are reduced first.">{(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{Object.entries(PAYMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          )}</Field>
          <Field label="Reason">{(p) => <Input {...p} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
