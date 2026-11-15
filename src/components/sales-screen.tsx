"use client";
import { Ban, Printer, ReceiptText, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Page } from "@/components/app-shell";
import { CreditNoteA4, InvoiceA4, type CreditNoteData } from "@/components/documents";
import { SalePrintButtons, usePrinter } from "@/components/sale-actions";
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { api, errorText, formatDate, formatDateTime, newRef, today, useApi } from "@/lib/api";
import { formatINR, parseQty } from "@/lib/money";
import { useShop } from "@/lib/session";
import { METHOD_LABELS, type Method, type Sale } from "@/lib/types";
import { formatQtyM } from "@/lib/units";

interface ListRow { id: number; invoice_no: string; status: string; sold_on: string; customer_name: string | null; grand_total: number; paid_total: number; due_amount: number; returned_total: number }
const PAGE = 100;

export function statusBadge(s: { status: string; due_amount: number; paid_total: number; returned_total?: number }) {
  if (s.status === "cancelled") return <Badge tone="danger">Cancelled</Badge>;
  if (s.due_amount === 0) return <Badge tone="success">Paid</Badge>;
  return s.paid_total > 0 ? <Badge tone="warn">Part paid</Badge> : <Badge tone="warn">Unpaid</Badge>;
}

export function SalesScreen() {
  const [form, setForm] = useState({ from: today(-30), to: today(), q: "", status: "all" });
  const [filter, setFilter] = useState(form);
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<number | null>(null);
  const list = useApi<{ rows: ListRow[]; count: number; total: number }>("sales.list", { ...filter, limit });

  return (
    <Page>
      <PageHeader title="Invoices" description="Search by invoice number, customer or date. Open an invoice to reprint, cancel or take a return." />
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (form.from > form.to) return void toast.error("The start date is after the end date"); setLimit(PAGE); setFilter(form); }}>
        <Field label="From">{(p) => <Input {...p} type="date" value={form.from} max={form.to} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
        <Field label="Status">{(p) => (
          <Select {...p} className="w-36" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="all">All</option><option value="paid">Paid</option><option value="partial">Part paid</option><option value="unpaid">Unpaid</option><option value="cancelled">Cancelled</option>
          </Select>
        )}</Field>
        <Field label="Search" className="min-w-48 flex-1">{(p) => <Input {...p} placeholder="Invoice no, customer name or phone" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} />}</Field>
        <Button type="submit" variant="primary">Show</Button>
      </form>
      <Card className="overflow-hidden">
        {list.error ? <div className="p-4"><ErrorNote onRetry={list.reload}>{list.error}</ErrorNote></div> : !list.data ? <Spinner />
          : list.data.rows.length === 0 ? <EmptyState icon={<ReceiptText />} title="No invoices found">Change the dates, status or search.</EmptyState> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2/60"><tr>
                  <th className={th}>Invoice</th><th className={th}>Date</th><th className={th}>Customer</th><th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>Balance due</th><th className={th}>Status</th>
                </tr></thead>
                <tbody className="divide-y divide-border">
                  {list.data.rows.map((s) => (
                    <tr key={s.id} tabIndex={0} onClick={() => setOpenId(s.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(s.id)} className="cursor-pointer hover:bg-surface-2">
                      <td className={`${td} num font-medium`}>{s.invoice_no}</td><td className={`${td} whitespace-nowrap text-muted`}>{formatDate(s.sold_on)}</td>
                      <td className={td}>{s.customer_name ?? <span className="text-muted">Cash sale</span>}</td>
                      <td className={`${td} num text-right font-medium`}>{formatINR(s.grand_total)}</td>
                      <td className={`${td} num text-right`}>{s.due_amount > 0 ? <span className="text-warn">{formatINR(s.due_amount)}</span> : "—"}</td>
                      <td className={td}>{statusBadge(s)} {s.returned_total > 0 && <Badge>Returned {formatINR(s.returned_total)}</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted">
                <span>Showing {list.data.rows.length} of {list.data.count} · total billed <span className="num">{formatINR(list.data.total)}</span></span>
                {list.data.rows.length < list.data.count && <Button size="sm" loading={list.loading} onClick={() => setLimit((l) => l + PAGE)}>Load more</Button>}
              </div>
            </div>
          )}
      </Card>
      {openId && <SaleDetail id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />}
    </Page>
  );
}

export function SaleDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const { settings, canManage } = useShop();
  const q = useApi<Sale>("sales.get", { id });
  const [cancelling, setCancelling] = useState(false);
  const [returning, setReturning] = useState(false);
  const printer = usePrinter();
  const sale = q.data;
  const canReturn = sale?.status === "completed" && sale.items.some((i) => i.returned_base_m < i.base_qty_m);
  const refunds = sale?.payments.filter((p) => p.kind === "refund") ?? [];

  const printCreditNote = async (returnId: number) => {
    try {
      const note = await api<CreditNoteData>("returns.get", { id: returnId });
      printer.start({ paper: "a4", mode: "print", content: <CreditNoteA4 note={note} sale={sale!} settings={settings} /> });
    } catch (e) { toast.error(errorText(e)); }
  };

  return (
    <Dialog open onClose={onClose} wide title={sale ? `Invoice ${sale.invoice_no}` : "Invoice"} footer={sale && (
      <>
        {canManage && sale.status === "completed" && sale.returns.length === 0 && <Button className="text-danger" onClick={() => setCancelling(true)}><Ban className="size-4" /> Cancel invoice</Button>}
        {canManage && canReturn && <Button onClick={() => setReturning(true)}><Undo2 className="size-4" /> Return goods</Button>}
        <SalePrintButtons sale={sale} />
      </>
    )}>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !sale ? <Spinner /> : (
        <div className="space-y-3">
          {sale.status === "cancelled" && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">Cancelled on {formatDateTime(sale.cancelled_at!)} — {sale.cancel_reason}</p>}
          {sale.returns.map((r) => (
            <p key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
              <span>Credit note <b className="num">{r.credit_note_no}</b> · {formatDate(r.returned_on)} · <b className="num">{formatINR(r.total)}</b>
                {r.due_reduced > 0 && <> · balance reduced by <span className="num">{formatINR(r.due_reduced)}</span></>}
                {r.refund_paid > 0 && <> · refunded <span className="num">{formatINR(r.refund_paid)}</span></>}{r.reason && <> · {r.reason}</>}</span>
              <Button size="sm" onClick={() => void printCreditNote(r.id)}><Printer className="size-4" /> Credit note</Button>
            </p>
          ))}
          {refunds.length > 0 && sale.status === "cancelled" && <p className="text-sm text-muted">Refund recorded: {refunds.map((p) => `${METHOD_LABELS[p.method]} ${formatINR(p.amount)}`).join(", ")}</p>}
          <div className="overflow-x-auto rounded-lg bg-white p-4 text-black"><InvoiceA4 sale={sale} settings={settings} /></div>
          <p className="text-xs text-muted">Billed by {sale.cashier ?? "—"} at {formatDateTime(sale.sold_at)}</p>
        </div>
      )}
      {printer.element}
      <ConfirmDialog open={cancelling} danger title="Cancel this invoice?" confirmLabel="Cancel invoice" reasonLabel="Reason (required)" onClose={() => setCancelling(false)}
        message={<>The goods go back into stock, any balance due is removed, and money received is recorded as refunded. The invoice number stays in the register as cancelled. This cannot be undone.</>}
        onConfirm={async (reason) => {
          try {
            await api("sales.cancel", { id, reason });
            toast.success("Invoice cancelled");
            setCancelling(false);
            await q.reload();
            onChanged?.();
          } catch (e) { toast.error(errorText(e)); }
        }} />
      {returning && sale && <ReturnDialog sale={sale} onClose={() => setReturning(false)} onDone={async () => { setReturning(false); await q.reload(); onChanged?.(); }} />}
    </Dialog>
  );
}

function ReturnDialog({ sale, onClose, onDone }: { sale: Sale; onClose: () => void; onDone: () => Promise<void> }) {
  const items = sale.items.filter((i) => i.returned_base_m < i.base_qty_m);
  const products = useApi<{ id: number; base_unit: string }[]>("products.list");
  const baseUnit = (pid: number) => products.data?.find((p) => p.id === pid)?.base_unit ?? "units";
  const [qty, setQty] = useState<Record<number, string>>({});
  const [disp, setDisp] = useState<Record<number, string>>({});
  const [method, setMethod] = useState<Method>("cash");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ref] = useState(newRef); // one id per dialog: pressing Save twice cannot create two credit notes

  const submit = async () => {
    const lines = [];
    for (const i of items) {
      const t = (qty[i.id] ?? "").trim();
      if (!t) continue;
      const m = parseQty(t);
      const left = i.base_qty_m - i.returned_base_m;
      if (m === null || m > left) return setError(`${i.name}: enter a quantity up to ${formatQtyM(left)} ${baseUnit(i.product_id)}`);
      lines.push({ sale_item_id: i.id, base_qty_m: m, disposition: disp[i.id] ?? "restock" });
    }
    if (lines.length === 0) return setError("Enter the quantity returned for at least one item.");
    setError("");
    setBusy(true);
    try {
      const r = await api<{ credit_note_no: string; refund_paid: number }>("sales.return", { client_ref: ref, sale_id: sale.id, items: lines, refund_method: method, reason });
      toast.success(`Credit note ${r.credit_note_no} recorded` + (r.refund_paid > 0 ? ` — refund ${formatINR(r.refund_paid)}` : ""));
      await onDone();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} wide title="Return goods" footer={<><Button onClick={onClose} disabled={busy}>Back</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>Record return</Button></>}>
      <div className="space-y-4 text-sm">
        <table className="w-full">
          <thead><tr><th className={th}>Item</th><th className={`${th} text-right`}>Can return</th><th className={`${th} text-right`}>Returning</th><th className={th}>Condition</th></tr></thead>
          <tbody className="divide-y divide-border">
            {items.map((i) => {
              const left = i.base_qty_m - i.returned_base_m, unit = baseUnit(i.product_id);
              return (
                <tr key={i.id}>
                  <td className={td}><span className="font-medium">{i.name}</span><span className="block text-xs text-muted">Sold {formatQtyM(i.qty_m)} {i.unit_name}</span></td>
                  <td className={`${td} num text-right`}>{formatQtyM(left)} {unit}</td>
                  <td className={`${td} text-right`}>
                    <span className="inline-flex items-center gap-1.5">
                      <Input aria-label={`Quantity of ${i.name} returned`} className="num h-9 w-24 text-right" inputMode="decimal" placeholder="0" value={qty[i.id] ?? ""} onChange={(e) => setQty({ ...qty, [i.id]: e.target.value })} />
                      <span className="text-xs text-muted">{unit}</span>
                      <Button size="sm" variant="ghost" onClick={() => setQty({ ...qty, [i.id]: formatQtyM(left) })}>All</Button>
                    </span>
                  </td>
                  <td className={td}>
                    <Select aria-label={`Condition of ${i.name}`} className="h-9 w-44" value={disp[i.id] ?? "restock"} onChange={(e) => setDisp({ ...disp, [i.id]: e.target.value })}>
                      <option value="restock">Good — back to stock</option><option value="melted">Melted</option><option value="damaged">Damaged</option><option value="expired">Expired</option>
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="text-xs text-muted">Quantities are in the smallest unit, so part of a carton can be returned. Melted, damaged or expired goods are recorded as wastage and do not go back on sale.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="If a refund is due, paid by" hint="Any balance due on this invoice is reduced first.">{(p) => <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as Method)}>{Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field>
          <Field label="Reason">{(p) => <Input {...p} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </div>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
