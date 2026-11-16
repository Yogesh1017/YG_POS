"use client";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui";
import { formatINR, rupeesToPaise } from "@/lib/money";
import type { ReportSummary } from "@/lib/report";

export function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" | "danger" }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted">{label}</div>
      <div className={`num mt-1 text-xl font-semibold ${tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : ""}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </Card>
  );
}

const inr = (rupees: number) => formatINR(rupeesToPaise(rupees));
const shortDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/** Billed amount per day. Days with no bills are filled in so gaps are visible. */
export function SalesTrend({ report }: { report: ReportSummary }) {
  const byDay = new Map(report.by_day.map((d) => [d.day, d]));
  const data: { day: string; total: number; count: number }[] = [];
  for (let d = new Date(`${report.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= report.to; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    data.push({ day: key, total: byDay.get(key)?.total ?? 0, count: byDay.get(key)?.count ?? 0 });
  }
  if (data.length < 2) return null;
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold">Sales per day</h2>
      <div className="h-56" role="img" aria-label="Bar chart of billed amount per day">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="day" tickFormatter={shortDay} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} minTickGap={16} />
            <YAxis width={52} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => (v >= 100000 ? `${(v / 100000).toFixed(1)}L` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))} />
            <Tooltip cursor={{ fill: "var(--surface-2)" }} contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--text)" }}
              labelFormatter={(l) => shortDay(String(l))} formatter={(v, _n, item) => [`${inr(Number(v))} · ${(item.payload as { count: number }).count} bills`, "Billed"]} />
            <Bar isAnimationActive={false} dataKey="total" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

/** The headline figures, with revenue, gross profit and tax kept clearly apart. */
export function HeadlineStats({ report }: { report: ReportSummary }) {
  const s = report.sales;
  const avg = s.count ? s.billed_total / s.count : 0;
  const margin = report.revenue > 0 ? Math.round((report.gross_profit / report.revenue) * 1000) / 10 : 0;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Billed (incl. tax)" value={inr(s.billed_total)} hint={`${s.count} bill${s.count === 1 ? "" : "s"} · avg ${inr(avg)}`} />
      <Stat label="Revenue (excl. tax, after returns)" value={inr(report.revenue)} hint={report.returns.count ? `Returns: ${inr(report.returns.total)}` : `Discounts given: ${inr(s.discount_total)}`} />
      <Stat label="Gross profit" value={inr(report.gross_profit)} hint={`${margin}% of revenue · before expenses`} tone={report.gross_profit < 0 ? "danger" : undefined} />
      <Stat label="GST collected" value={inr(s.tax_total - report.returns.tax_total)} hint={report.cancelled_count ? `${report.cancelled_count} bill(s) cancelled` : "Net of returns"} />
    </div>
  );
}
export { inr };
