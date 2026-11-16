"use client";
import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { Badge, Button, Card, ErrorNote, Field, Input, PageHeader, Spinner, cn, td, th } from "@/components/ui";
import { downloadCsv, formatDate, fyOf, today, useApi } from "@/lib/api";
import { formatINR, formatPaise } from "@/lib/money";
import { useShop } from "@/lib/session";
import { METHOD_LABELS, type Method } from "@/lib/types";
import { formatQtyM } from "@/lib/units";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = "profit" | "products" | "customers" | "purchases" | "wastage" | "outstanding" | "stock" | "gst" | "register";
const TABS: { id: Tab; label: string; range: boolean }[] = [
  { id: "profit", label: "Sales and profit", range: true }, { id: "products", label: "Products", range: true }, { id: "customers", label: "Customers", range: true },
  { id: "purchases", label: "Purchases", range: true }, { id: "wastage", label: "Wastage", range: true }, { id: "outstanding", label: "Outstanding", range: false },
  { id: "stock", label: "Stock", range: false }, { id: "gst", label: "GST", range: true }, { id: "register", label: "Invoice register", range: false },
];
const METHODS: Record<Tab, string> = { profit: "reports.summary", products: "reports.products", customers: "reports.customers", purchases: "reports.purchases", wastage: "reports.wastage", outstanding: "reports.outstanding", stock: "reports.stock", gst: "reports.gst", register: "reports.invoiceRegister" };
const rs = (paise: number) => (paise / 100).toFixed(2);

function presets(): { label: string; from: string; to: string }[] {
  const t = today(), dow = new Date().getDay();
  const d = new Date(); d.setDate(0);
  const lastEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return [
    { label: "Today", from: t, to: t }, { label: "Yesterday", from: today(-1), to: today(-1) }, { label: "This week", from: today(-((dow + 6) % 7)), to: t },
    { label: "This month", from: `${t.slice(0, 8)}01`, to: t }, { label: "Last month", from: `${lastEnd.slice(0, 8)}01`, to: lastEnd },
  ];
}

interface Col { head: string; right?: boolean; cell: (r: any) => ReactNode; csv: (r: any) => string | number | null }
function Table({ cols, rows, empty }: { cols: Col[]; rows: any[]; empty: string }) {
  if (rows.length === 0) return <p className="px-4 py-8 text-center text-sm text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto"><table className="w-full text-sm">
      <thead className="border-b border-border bg-surface-2/60"><tr>{cols.map((c) => <th key={c.head} className={cn(th, c.right && "text-right")}>{c.head}</th>)}</tr></thead>
      <tbody className="divide-y divide-border">{rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c.head} className={cn(td, c.right && "num text-right")}>{c.cell(r)}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
const money = (head: string, key: string, strong = false): Col => ({ head, right: true, cell: (r) => <span className={strong ? "font-medium" : ""}>{formatPaise(r[key])}</span>, csv: (r) => rs(r[key]) });
const text = (head: string, key: string): Col => ({ head, cell: (r) => r[key], csv: (r) => r[key] });

export default function ReportsPage() {
  return <ManagersOnly><Reports /></ManagersOnly>;
}

function Reports() {
  const { gst, settings } = useShop();
  const [tab, setTab] = useState<Tab>("profit");
  const [range, setRange] = useState({ from: `${today().slice(0, 8)}01`, to: today() });
  const [form, setForm] = useState(range);
  const [fy, setFy] = useState(fyOf(today()));
  const meta = TABS.find((t) => t.id === tab)!;
  const q = useApi<any>(METHODS[tab], tab === "register" ? { fy } : meta.range ? range : {});
  const d = q.data;
  const apply = (from: string, to: string) => { if (from > to) return void toast.error("The start date is after the end date"); setForm({ from, to }); setRange({ from, to }); };
  const sections: { title: string; cols: Col[]; rows: any[]; empty: string; note?: ReactNode }[] = [];

  if (d && tab === "products") sections.push({ title: "Sales by product", empty: "No sales in this period.", rows: d, cols: [
    { head: "Product", cell: (r) => <><span className="font-medium">{r.name}</span>{r.brand_name && <span className="text-muted"> · {r.brand_name}</span>}</>, csv: (r) => r.name },
    { head: "Sold", right: true, cell: (r) => `${formatQtyM(r.sold_base_m)} ${r.base_unit}`, csv: (r) => r.sold_base_m / 1000 },
    { head: "Returned", right: true, cell: (r) => (r.returned_base_m ? formatQtyM(r.returned_base_m) : ""), csv: (r) => r.returned_base_m / 1000 },
    money("Taxable value", "taxable"), money("Cost", "cost"), money("Gross profit", "profit", true), money("Billed", "total") ] });
  if (d && tab === "customers") sections.push({ title: "Sales by customer", empty: "No sales in this period.", rows: d, cols: [
    { head: "Customer", cell: (r) => <span className="font-medium">{r.name}</span>, csv: (r) => r.name }, { head: "Invoices", right: true, cell: (r) => r.invoices, csv: (r) => r.invoices },
    money("Billed", "billed", true), money("Taxable value", "taxable"), money("Gross profit", "profit"), money("Returned", "returned"), money("Balance due now", "balance") ] });
  if (d && tab === "purchases") sections.push(
    { title: "Purchases by supplier", empty: "No purchases in this period.", rows: d.by_supplier, cols: [text("Supplier", "name"), { head: "Bills", right: true, cell: (r) => r.bills, csv: (r) => r.bills }, money("Total", "total", true), money("GST paid", "tax"), money("Paid", "paid"), money("We owe now", "balance")] },
    { title: "Purchases by product", empty: "No purchases in this period.", rows: d.by_product, cols: [text("Product", "name"), { head: "Quantity", right: true, cell: (r) => `${formatQtyM(r.base_qty_m)} ${r.base_unit}`, csv: (r) => r.base_qty_m / 1000 }, money("Taxable value", "taxable"), money("Total", "total", true)] });
  if (d && tab === "wastage") sections.push(
    { title: "Wastage by reason (at cost)", empty: "No wastage recorded in this period.", rows: d.by_reason, cols: [{ head: "Reason", cell: (r) => <span className="capitalize">{r.reason}</span>, csv: (r) => r.reason }, { head: "Entries", right: true, cell: (r) => r.entries, csv: (r) => r.entries }, money("Cost", "cost", true)] },
    { title: "Wastage entries", empty: "No wastage recorded in this period.", rows: d.rows, cols: [
      { head: "Date", cell: (r) => formatDate(r.moved_on), csv: (r) => r.moved_on }, text("Product", "name"), { head: "Reason", cell: (r) => <><span className="capitalize">{r.reason}</span>{!!r.from_return && <Badge>customer return</Badge>}</>, csv: (r) => r.reason },
      { head: "Quantity", right: true, cell: (r) => `${formatQtyM(r.qty_m)} ${r.base_unit}`, csv: (r) => r.qty_m / 1000 }, { head: "Batch", cell: (r) => r.batch_no, csv: (r) => r.batch_no }, money("Cost", "cost"), text("Note", "note")] });
  if (d && tab === "outstanding") sections.push(
    { title: `Customers who owe — ${formatINR(d.customers.reduce((a: number, c: any) => a + c.balance, 0))}`, empty: "No customer owes anything.", rows: d.customers, cols: [text("Customer", "name"), text("Phone", "phone"), { head: "Unpaid invoices", right: true, cell: (r) => r.unpaid_invoices, csv: (r) => r.unpaid_invoices },
      { head: "Oldest unpaid", cell: (r) => formatDate(r.oldest_due_on), csv: (r) => r.oldest_due_on }, { head: "Credit limit", right: true, cell: (r) => (r.credit_limit !== null ? formatPaise(r.credit_limit) : ""), csv: (r) => (r.credit_limit !== null ? rs(r.credit_limit) : "") }, money("Balance due", "balance", true)] },
    { title: `Suppliers we owe — ${formatINR(d.suppliers.reduce((a: number, c: any) => a + c.balance, 0))}`, empty: "Nothing is owed to suppliers.", rows: d.suppliers, cols: [text("Supplier", "name"), text("Phone", "phone"), { head: "Oldest unpaid bill", cell: (r) => formatDate(r.oldest_due_on), csv: (r) => r.oldest_due_on }, money("We owe", "balance", true)] });
  if (d && tab === "stock") sections.push({ title: `Stock on hand — value at cost ${formatINR(d.stock_value)}${d.expired_value ? ` (of which expired ${formatINR(d.expired_value)})` : ""}`, empty: "No products.", rows: d.rows, cols: [
    text("Product", "name"), { head: "In stock", right: true, cell: (r) => `${formatQtyM(r.on_hand_m)} ${r.base_unit}`, csv: (r) => r.on_hand_m / 1000 },
    { head: "Expired", right: true, cell: (r) => (r.expired_m ? <span className="text-danger">{formatQtyM(r.expired_m)}</span> : ""), csv: (r) => r.expired_m / 1000 },
    { head: "Warn at", right: true, cell: (r) => formatQtyM(r.low_stock_m), csv: (r) => r.low_stock_m / 1000 }, money("Value at cost", "value", true)] });
  if (d && tab === "gst") sections.push(
    { title: "Output GST by rate (on invoices, before credit notes)", empty: "No sales in this period.", rows: d.by_rate, cols: [{ head: "Rate", cell: (r) => `${r.tax_rate_bp / 100}%`, csv: (r) => r.tax_rate_bp / 100 }, money("Taxable value", "taxable"), money("CGST", "cgst"), money("SGST", "sgst"), money("IGST", "igst")],
      note: <>Credit notes in this period: {d.credit_notes.count}, taxable <span className="num">{formatPaise(d.credit_notes.taxable)}</span>, tax <span className="num">{formatPaise(d.credit_notes.tax)}</span>. GST paid on purchases (input): <span className="num">{formatINR(d.input_tax)}</span>.</> },
    { title: "HSN summary", empty: "No sales in this period.", rows: d.by_hsn, cols: [{ head: "HSN", cell: (r) => r.hsn_code || <span className="text-warn">missing</span>, csv: (r) => r.hsn_code }, { head: "Rate", right: true, cell: (r) => `${r.tax_rate_bp / 100}%`, csv: (r) => r.tax_rate_bp / 100 },
      { head: "Quantity (base units)", right: true, cell: (r) => formatQtyM(r.base_qty_m), csv: (r) => r.base_qty_m / 1000 }, money("Taxable value", "taxable"), money("Tax", "tax")] });
  if (d && tab === "register") sections.push(
    { title: `Invoices in ${fy} — last number issued: ${d.last_no}`, empty: "No invoices in this financial year.", rows: d.rows, cols: [text("Invoice", "invoice_no"), { head: "Date", cell: (r) => formatDate(r.sold_on), csv: (r) => r.sold_on }, { head: "Customer", cell: (r) => r.customer_name ?? "Cash sale", csv: (r) => r.customer_name ?? "Cash sale" },
      { head: "Status", cell: (r) => (r.status === "cancelled" ? <Badge tone="danger">Cancelled — {r.cancel_reason}</Badge> : "Issued"), csv: (r) => (r.status === "cancelled" ? `Cancelled: ${r.cancel_reason}` : "Issued") }, money("Total", "grand_total")],
      note: d.missing.length ? <span className="text-danger">Numbers with no invoice on record: {d.missing.join(", ")}. This should not happen in normal use; it can follow restoring an older backup.</span> : "No numbers are missing from the sequence." },
    { title: "Credit notes", empty: "No credit notes in this financial year.", rows: d.credit_notes, cols: [text("Credit note", "credit_note_no"), { head: "Date", cell: (r) => formatDate(r.returned_on), csv: (r) => r.returned_on }, money("Value", "total")] });

  const exportCsv = () => {
    if (!d) return;
    const head = [[settings.business_name], [meta.label, meta.range ? `${range.from} to ${range.to}` : tab === "register" ? fy : `as of ${today()}`], []];
    if (tab === "profit") {
      downloadCsv(`profit_${range.from}_${range.to}.csv`, [...head as any,
        ["Invoices", d.sales.count], ["Billed incl. GST", rs(d.sales.billed)], ["Revenue (taxable, after returns)", rs(d.revenue)], ["Cost of goods sold", rs(d.sales.cost - d.returns.cost)], ["Gross profit", rs(d.gross_profit)],
        ["Wastage at cost", rs(d.wastage)], ["Expenses", rs(d.expenses)], ["Net profit", rs(d.net_profit)], ["GST on invoices", rs(d.sales.tax)], ["Returns", rs(d.returns.total)], ["Purchases", rs(d.purchases.total)], [],
        ["Day", "Invoices", "Billed"], ...d.by_day.map((x: any) => [x.day, x.count, rs(x.total)]), [], ["Method", "Received", "Refunded"], ...d.by_method.map((x: any) => [METHOD_LABELS[x.method as Method], rs(x.received), rs(x.refunded)])]);
    } else downloadCsv(`${tab}_${today()}.csv`, [...head as any, ...sections.flatMap((s) => [[s.title], s.cols.map((c) => c.head), ...s.rows.map((r) => s.cols.map((c) => c.csv(r))), []])]);
  };

  return (
    <Page>
      <PageHeader title="Reports" actions={<Button onClick={exportCsv} disabled={!d}><Download className="size-4" /> Export CSV</Button>} />
      <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.filter((t) => t.id !== "gst" || gst).map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap", tab === t.id ? "border-primary text-primary" : "border-transparent text-muted hover:text-text")}>{t.label}</button>)}
      </div>
      {meta.range && (
        <div className="mb-4 flex flex-wrap items-end gap-2">
          {presets().map((p) => <Button key={p.label} size="sm" variant={range.from === p.from && range.to === p.to ? "primary" : "secondary"} onClick={() => apply(p.from, p.to)}>{p.label}</Button>)}
          <form className="ml-auto flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); apply(form.from, form.to); }}>
            <Field label="From">{(p) => <Input {...p} type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />}</Field>
            <Field label="To">{(p) => <Input {...p} type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />}</Field>
            <Button type="submit">Show</Button>
          </form>
        </div>
      )}
      {tab === "register" && <Field label="Financial year" className="mb-4 w-40">{(p) => <Input {...p} className="num" placeholder="26-27" value={fy} onChange={(e) => setFy(e.target.value)} />}</Field>}
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !d ? <Spinner /> : tab === "profit" ? <Profit d={d} /> : (
        <div className="space-y-4">
          {sections.map((s) => (
            <Card key={s.title} className="overflow-hidden">
              <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">{s.title}</h2>
              <Table cols={s.cols} rows={s.rows} empty={s.empty} />
              {s.note && <p className="border-t border-border px-4 py-2.5 text-xs text-muted">{s.note}</p>}
            </Card>
          ))}
          {tab === "gst" && <p className="text-xs text-muted">A working summary to help you or your accountant prepare returns. Check it before filing — this software has not been certified for GST compliance.</p>}
        </div>
      )}
    </Page>
  );
}

function Profit({ d }: { d: any }) {
  const line = (label: string, value: number, opts: { strong?: boolean; minus?: boolean; hint?: string } = {}) => (
    <div className={cn("flex items-baseline justify-between gap-4 py-1.5", opts.strong && "border-t border-border font-semibold")}>
      <span>{label}{opts.hint && <span className="ml-2 text-xs font-normal text-muted">{opts.hint}</span>}</span>
      <span className={cn("num", opts.strong && value < 0 && "text-danger")}>{opts.minus && value > 0 ? "− " : ""}{formatINR(value)}</span>
    </div>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4 text-sm">
        <h2 className="mb-2 text-sm font-semibold">Profit</h2>
        {line("Sales (taxable value)", d.sales.taxable, { hint: `${d.sales.count} invoices, after ₹${formatPaise(d.sales.discount)} discount` })}
        {line("Returns", d.returns.taxable, { minus: true, hint: d.returns.count ? `${d.returns.count} credit notes` : undefined })}
        {line("Revenue", d.revenue, { strong: true, hint: "excludes GST" })}
        {line("Cost of goods sold", d.sales.cost - d.returns.cost, { minus: true, hint: "actual cost of the batches sold" })}
        {line("Gross profit", d.gross_profit, { strong: true, hint: d.revenue > 0 ? `${Math.round((d.gross_profit / d.revenue) * 1000) / 10}% of revenue` : undefined })}
        {line("Wastage", d.wastage, { minus: true, hint: "damaged, melted, expired — at cost" })}
        {line("Expenses", d.expenses, { minus: true })}
        {line("Net profit", d.net_profit, { strong: true })}
      </Card>
      <div className="space-y-4">
        <Card className="p-4 text-sm">
          <h2 className="mb-2 text-sm font-semibold">Money</h2>
          {line("Billed including GST", d.sales.billed)}
          {line("GST on invoices", d.sales.tax, { hint: "collected for the government, not income" })}
          {line("Sold on credit in this period", d.sales.credit_given)}
          {line("Purchases entered", d.purchases.total, { hint: `${d.purchases.count} bills` })}
          {line("Customers owe (now)", d.customer_dues)}
          {line("We owe suppliers (now)", d.supplier_dues)}
          {d.cancelled_count > 0 && <p className="pt-1 text-xs text-muted">{d.cancelled_count} invoice(s) cancelled in this period.</p>}
        </Card>
        <Card className="overflow-hidden">
          <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">Payments recorded by method</h2>
          <Table empty="No payments in this period." rows={d.by_method} cols={[{ head: "Method", cell: (r) => METHOD_LABELS[r.method as Method], csv: () => "" }, money("Received", "received"), money("Refunded", "refunded"), { head: "Net", right: true, cell: (r) => <b>{formatPaise(r.received - r.refunded)}</b>, csv: () => "" }]} />
        </Card>
      </div>
      <Card className="overflow-hidden lg:col-span-2">
        <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">Sales by day</h2>
        <Table empty="No sales in this period." rows={d.by_day} cols={[{ head: "Day", cell: (r) => formatDate(r.day), csv: () => "" }, { head: "Invoices", right: true, cell: (r) => r.count, csv: () => "" }, money("Billed", "total", true)]} />
      </Card>
    </div>
  );
}
