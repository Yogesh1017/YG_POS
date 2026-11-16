"use client";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { HeadlineStats, SalesTrend, inr } from "@/components/report-widgets";
import { Button, Card, ErrorNote, Field, Input, PageHeader, Spinner, td, th } from "@/components/ui";
import { PAYMENT_LABELS, istDate } from "@/lib/invoice";
import type { ReportSummary } from "@/lib/report";
import { useShop } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { downloadCsv, unwrap, useQuery } from "@/lib/use-query";

export default function ReportsPage() {
  return <ManagersOnly><Reports /></ManagersOnly>;
}

function presets(): { label: string; from: string; to: string }[] {
  const today = istDate();
  const [y, m] = today.split("-").map(Number);
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // week starts Monday
  const lastMonthEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return [
    { label: "Today", from: today, to: today },
    { label: "Yesterday", from: istDate(-1), to: istDate(-1) },
    { label: "This week", from: istDate(-((dow + 6) % 7)), to: today },
    { label: "This month", from: `${today.slice(0, 8)}01`, to: today },
    { label: "Last month", from: `${lastMonthEnd.slice(0, 8)}01`, to: lastMonthEnd },
  ];
}

function Reports() {
  const { business } = useShop();
  const [range, setRange] = useState({ from: `${istDate().slice(0, 8)}01`, to: istDate() });
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const q = useQuery(async () => unwrap(await supabase().rpc("report_summary", { p_business_id: business.id, p_from: range.from, p_to: range.to })) as ReportSummary, [business.id, range]);
  const r = q.data;
  const apply = (f: string, t: string) => {
    if (f > t) return void toast.error("The start date is after the end date");
    setFrom(f); setTo(t); setRange({ from: f, to: t });
  };

  const exportCsv = () => {
    if (!r) return;
    downloadCsv(`sales-report_${r.from}_to_${r.to}.csv`, [
      ["Sales report", business.name], ["From", r.from, "To", r.to], [],
      ["Bills", r.sales.count], ["Billed incl. tax", r.sales.billed_total], ["Revenue excl. tax after returns", r.revenue],
      ["Cost of goods sold", r.sales.cost_total - r.returns.cost_total], ["Gross profit (before expenses)", r.gross_profit],
      ["GST collected net of returns", r.sales.tax_total - r.returns.tax_total], ["Discounts given", r.sales.discount_total], ["Returns", r.returns.total], [],
      ["Day", "Bills", "Billed"], ...r.by_day.map((d) => [d.day, d.count, d.total]), [],
      ["Payment method", "Received", "Refunded", "Net"], ...r.by_method.map((p) => [PAYMENT_LABELS[p.method], p.received, p.refunded, p.received - p.refunded]), [],
      ["GST rate %", "Taxable value", "CGST", "SGST", "IGST"], ...r.gst_by_rate.map((g) => [g.tax_rate, g.taxable, g.cgst, g.sgst, g.igst]), [],
      ["HSN/SAC", "GST rate %", "Quantity", "Taxable value", "Tax"], ...r.gst_by_hsn.map((g) => [g.hsn_code || "(none)", g.tax_rate, g.qty, g.taxable, g.tax]), [],
      ["Product", "Quantity sold", "Amount"], ...r.top_products.map((p) => [p.name, p.qty, p.total]),
    ]);
  };

  return (
    <Page>
      <PageHeader title="Reports" description="Sales, profit and GST for any period" actions={<Button onClick={exportCsv} disabled={!r}><Download className="size-4" /> Export CSV</Button>} />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        {presets().map((p) => <Button key={p.label} size="sm" variant={range.from === p.from && range.to === p.to ? "primary" : "secondary"} onClick={() => apply(p.from, p.to)}>{p.label}</Button>)}
        <form className="ml-auto flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); apply(from, to); }}>
          <Field label="From">{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="To">{(p) => <Input {...p} type="date" value={to} max={istDate()} onChange={(e) => setTo(e.target.value)} />}</Field>
          <Button type="submit">Show</Button>
        </form>
      </div>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !r ? <Spinner /> : (
        <div className="space-y-4">
          <HeadlineStats report={r} />
          <p className="text-xs text-muted">
            Gross profit = revenue − cost of the goods sold (using each product&apos;s cost price at the time of sale). It is before rent, salaries and other expenses;
            this version does not record expenses, so no net profit is shown.
          </p>
          <SalesTrend report={r} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="overflow-hidden">
              <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">Money received by method</h2>
              {r.by_method.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">No payments in this period.</p> : (
                <table className="w-full text-sm"><thead><tr><th className={th}>Method</th><th className={`${th} text-right`}>Received</th><th className={`${th} text-right`}>Refunded</th><th className={`${th} text-right`}>Net</th></tr></thead>
                  <tbody className="divide-y divide-border">{r.by_method.map((p) => (
                    <tr key={p.method}><td className={td}>{PAYMENT_LABELS[p.method]}</td><td className={`${td} num text-right`}>{inr(p.received)}</td><td className={`${td} num text-right text-muted`}>{inr(p.refunded)}</td><td className={`${td} num text-right font-medium`}>{inr(p.received - p.refunded)}</td></tr>
                  ))}</tbody></table>
              )}
              <p className="px-4 py-3 text-xs text-muted">Includes dues collected in this period. Sold on credit in this period: <span className="num">{inr(r.sales.credit_given)}</span>.</p>
            </Card>
            <Card className="overflow-hidden">
              <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">Best-selling products</h2>
              {r.top_products.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">No sales in this period.</p> : (
                <table className="w-full text-sm"><thead><tr><th className={th}>Product</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Amount</th></tr></thead>
                  <tbody className="divide-y divide-border">{r.top_products.map((p) => <tr key={p.product_id}><td className={td}>{p.name}</td><td className={`${td} num text-right`}>{p.qty}</td><td className={`${td} num text-right font-medium`}>{inr(p.total)}</td></tr>)}</tbody></table>
              )}
            </Card>
          </div>
          {business.gst_registered && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="overflow-hidden">
                <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">GST by rate <span className="font-normal text-muted">— on bills, before returns</span></h2>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className={th}>Rate</th><th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>CGST</th><th className={`${th} text-right`}>SGST</th><th className={`${th} text-right`}>IGST</th></tr></thead>
                  <tbody className="divide-y divide-border">{r.gst_by_rate.map((g) => <tr key={g.tax_rate}><td className={`${td} num`}>{g.tax_rate}%</td><td className={`${td} num text-right`}>{inr(g.taxable)}</td><td className={`${td} num text-right`}>{inr(g.cgst)}</td><td className={`${td} num text-right`}>{inr(g.sgst)}</td><td className={`${td} num text-right`}>{inr(g.igst)}</td></tr>)}</tbody></table></div>
                {r.returns.count > 0 && <p className="px-4 py-3 text-xs text-muted">Credit notes in this period: taxable <span className="num">{inr(r.returns.taxable_total)}</span>, tax <span className="num">{inr(r.returns.tax_total)}</span>.</p>}
              </Card>
              <Card className="overflow-hidden">
                <h2 className="px-4 pt-4 pb-2 text-sm font-semibold">HSN / SAC summary</h2>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className={th}>HSN/SAC</th><th className={`${th} text-right`}>Rate</th><th className={`${th} text-right`}>Qty</th><th className={`${th} text-right`}>Taxable</th><th className={`${th} text-right`}>Tax</th></tr></thead>
                  <tbody className="divide-y divide-border">{r.gst_by_hsn.map((g) => <tr key={`${g.hsn_code}-${g.tax_rate}`}><td className={`${td} num`}>{g.hsn_code || <span className="text-warn">missing</span>}</td><td className={`${td} num text-right`}>{g.tax_rate}%</td><td className={`${td} num text-right`}>{g.qty}</td><td className={`${td} num text-right`}>{inr(g.taxable)}</td><td className={`${td} num text-right`}>{inr(g.tax)}</td></tr>)}</tbody></table></div>
              </Card>
              <p className="text-xs text-muted lg:col-span-2">These figures are a working summary to help you or your accountant prepare returns. Check them before filing — this software has not been certified for GST compliance.</p>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}
