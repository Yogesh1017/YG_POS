"use client";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Page } from "@/components/app-shell";
import { HeadlineStats, SalesTrend, Stat, inr } from "@/components/report-widgets";
import { Badge, Card, ErrorNote, PageHeader, Spinner } from "@/components/ui";
import { db } from "@/lib/db";
import { istDate } from "@/lib/invoice";
import type { ReportSummary } from "@/lib/report";
import { useShop } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { unwrap, useQuery } from "@/lib/use-query";

export default function DashboardPage() {
  const { business, canManage } = useShop();
  const router = useRouter();
  useEffect(() => { if (!canManage) router.replace("/pos/"); }, [canManage, router]);
  if (!canManage) return <Spinner />;
  return <Dashboard businessId={business.id} />;
}

function Dashboard({ businessId }: { businessId: string }) {
  const today = istDate();
  const q = useQuery(async () => {
    const [day, week] = await Promise.all([
      supabase().rpc("report_summary", { p_business_id: businessId, p_from: today, p_to: today }),
      supabase().rpc("report_summary", { p_business_id: businessId, p_from: istDate(-13), p_to: today }),
    ]);
    return { day: unwrap(day) as ReportSummary, trend: unwrap(week) as ReportSummary };
  }, [businessId, today]);
  const low = useLiveQuery(() => db.products.where("business_id").equals(businessId).and((p) => p.track_stock && p.is_active && p.stock_qty <= p.low_stock_threshold).toArray(), [businessId]) ?? [];

  return (
    <Page>
      <PageHeader title="Today" description={new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" })} />
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !q.data ? <Spinner /> : (
        <div className="space-y-4">
          <HeadlineStats report={q.data.day} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Sold on credit today" value={inr(q.data.day.sales.credit_given)} />
            <Stat label="Total dues to collect" value={inr(q.data.day.outstanding_dues)} tone={q.data.day.outstanding_dues > 0 ? "warn" : undefined} />
            <Stat label="Stock value at cost" value={inr(q.data.day.stock_value)} />
            <Stat label="Low or out of stock" value={String(q.data.day.low_stock_count)} tone={q.data.day.low_stock_count > 0 ? "warn" : undefined} />
          </div>
          <SalesTrend report={q.data.trend} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold">Best sellers — last 14 days</h2>
              {q.data.trend.top_products.length === 0 ? <p className="text-sm text-muted">No sales yet.</p> : (
                <ol className="space-y-2 text-sm">{q.data.trend.top_products.slice(0, 6).map((p) => (
                  <li key={p.product_id} className="flex justify-between gap-3"><span className="truncate">{p.name}</span><span className="num shrink-0 text-muted">{p.qty} sold · <span className="text-text">{inr(p.total)}</span></span></li>
                ))}</ol>
              )}
            </Card>
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">Running low</h2><Link href="/inventory/" className="text-xs font-medium text-primary hover:underline">Open stock</Link></div>
              {low.length === 0 ? <p className="text-sm text-muted">Nothing is running low.</p> : (
                <ul className="space-y-2 text-sm">{low.sort((a, b) => a.stock_qty - b.stock_qty).slice(0, 6).map((p) => (
                  <li key={p.id} className="flex justify-between gap-3"><span className="truncate">{p.name}</span><Badge tone={p.stock_qty <= 0 ? "danger" : "warn"}>{p.stock_qty <= 0 ? "Out" : `${p.stock_qty} ${p.unit} left`}</Badge></li>
                ))}</ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}
