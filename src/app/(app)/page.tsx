"use client";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Page } from "@/components/app-shell";
import { Badge, Card, ErrorNote, PageHeader, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";
import { formatINR } from "@/lib/money";
import { useShop } from "@/lib/session";
import { formatQtyM } from "@/lib/units";

/* eslint-disable @typescript-eslint/no-explicit-any */
function Stat({ label, value, hint, tone, href }: { label: string; value: string; hint?: string; tone?: "warn" | "danger"; href?: string }) {
  const body = (
    <Card className="h-full p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num mt-1 text-xl font-semibold ${tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : ""}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  );
  return href ? <Link href={href} className="block rounded-xl hover:ring-2 hover:ring-ring/40">{body}</Link> : body;
}
const shortDay = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); };

export default function DashboardPage() {
  const { canManage } = useShop();
  const q = useApi<any>("reports.dashboard");
  const d = q.data;
  const trend: { day: string; total: number; count: number }[] = [];
  if (d) {
    const by = new Map<string, any>(d.trend.map((t: any) => [t.day, t]));
    const [y, m, day] = d.trend_from.split("-").map(Number);
    for (let i = 0; i < 14; i++) {
      const dt = new Date(y, m - 1, day + i);
      const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
      trend.push({ day: key, total: (by.get(key)?.total ?? 0) / 100, count: by.get(key)?.count ?? 0 });
    }
  }
  return (
    <Page>
      <PageHeader title="Dashboard" description={new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} />
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !d ? <Spinner /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Today's sales" value={formatINR(d.today.sales.billed)} hint={`${d.today.sales.count} invoice${d.today.sales.count === 1 ? "" : "s"} · ${d.today.units_sold_lines} lines`} href="/sales/" />
            <Stat label="This month's sales" value={formatINR(d.month.sales.billed)} hint={`${d.month.sales.count} invoices`} />
            {canManage ? <Stat label="Gross profit this month" value={formatINR(d.month.gross_profit)} hint={`Net after wastage and expenses: ${formatINR(d.month.net_profit)}`} tone={d.month.net_profit < 0 ? "danger" : undefined} href="/reports/" />
              : <Stat label="Sold on credit today" value={formatINR(d.today.sales.credit_given)} />}
            <Stat label="Customers owe" value={formatINR(d.today.customer_dues)} tone={d.today.customer_dues > 0 ? "warn" : undefined} href="/customers/" />
          </div>
          {canManage && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Purchases this month" value={formatINR(d.month.purchases.total)} hint={`${d.month.purchases.count} bills`} href="/purchases/" />
              <Stat label="We owe suppliers" value={formatINR(d.today.supplier_dues)} tone={d.today.supplier_dues > 0 ? "warn" : undefined} href="/suppliers/" />
              <Stat label="Stock value at cost" value={formatINR(d.stock_value)} href="/inventory/" />
              <Stat label="Wastage this month" value={formatINR(d.month.wastage)} hint={d.expired_count ? `${d.expired_count} product(s) have expired stock to write off` : "Damaged, melted, expired"} tone={d.expired_count ? "danger" : undefined} href="/inventory/" />
            </div>
          )}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">Sales — last 14 days</h2>
            <div className="h-52" role="img" aria-label="Bar chart of sales per day for the last 14 days">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={16} />
                  <YAxis width={52} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))} />
                  <Tooltip cursor={{ fill: "var(--surface-2)" }} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" }}
                    labelFormatter={(l) => shortDay(String(l))} formatter={(v, _n, item) => [`${formatINR(Math.round(Number(v) * 100))} · ${(item.payload as { count: number }).count} invoices`, "Sales"]} />
                  <Bar isAnimationActive={false} dataKey="total" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={36} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold">Best sellers this month</h2>
              {d.top_products.length === 0 ? <p className="text-sm text-muted">No sales yet this month.</p> : (
                <ol className="space-y-2 text-sm">{d.top_products.map((p: any) => (
                  <li key={p.product_id} className="flex justify-between gap-3"><span className="truncate">{p.name}</span><span className="num shrink-0 text-muted">{formatQtyM(p.base_qty_m)} {p.base_unit} · <span className="text-text">{formatINR(p.total)}</span></span></li>
                ))}</ol>
              )}
            </Card>
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Low stock ({d.low_stock_count})</h2>{canManage && <Link href="/inventory/" className="text-xs font-medium text-primary hover:underline">Open stock</Link>}</div>
              {d.low_stock.length === 0 ? <p className="text-sm text-muted">Nothing is running low.</p> : (
                <ul className="space-y-2 text-sm">{d.low_stock.map((p: any) => {
                  const left = p.on_hand_m - p.expired_m;
                  return <li key={p.id} className="flex justify-between gap-3"><span className="truncate">{p.name}</span><Badge tone={left <= 0 ? "danger" : "warn"}>{left <= 0 ? "Out of stock" : `${formatQtyM(left)} ${p.base_unit} left`}</Badge></li>;
                })}</ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}
