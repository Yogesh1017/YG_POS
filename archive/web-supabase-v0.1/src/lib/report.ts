import type { PaymentMethod } from "./types";

/** Shape returned by the report_summary() database function. Amounts are rupees. */
export interface ReportSummary {
  from: string;
  to: string;
  sales: { count: number; billed_total: number; taxable_total: number; tax_total: number; discount_total: number; cost_total: number; credit_given: number };
  returns: { count: number; total: number; taxable_total: number; tax_total: number; cost_total: number };
  revenue: number;
  gross_profit: number;
  cancelled_count: number;
  by_day: { day: string; total: number; count: number }[];
  by_method: { method: PaymentMethod; received: number; refunded: number }[];
  top_products: { product_id: string; name: string; qty: number; total: number }[];
  gst_by_rate: { tax_rate: number; taxable: number; cgst: number; sgst: number; igst: number }[];
  gst_by_hsn: { hsn_code: string; tax_rate: number; qty: number; taxable: number; tax: number }[];
  outstanding_dues: number;
  stock_value: number;
  low_stock_count: number;
}
