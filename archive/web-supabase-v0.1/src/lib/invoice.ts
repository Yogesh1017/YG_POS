import { rateToBp, rupeesToPaise, qtyToMilli } from "./money";
import type { InvoiceData, PaymentMethod } from "./types";

export const PAYMENT_LABELS: Record<PaymentMethod, string> = { cash: "Cash", upi: "UPI", card: "Card", other: "Other" };

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Build printable invoice data from a sale row fetched with its sale_items and payments. */
export function invoiceFromServer(sale: any, cashier: string | null = null): InvoiceData {
  const p = rupeesToPaise;
  const items = [...(sale.sale_items ?? [])].sort((a: any, b: any) => a.line_no - b.line_no);
  return {
    id: sale.id,
    invoiceNo: sale.invoice_no,
    status: sale.status,
    soldAt: sale.sold_at,
    cashier,
    customer: { name: sale.customer_name, phone: sale.customer_phone, gstin: sale.customer_gstin },
    placeOfSupply: sale.place_of_supply,
    interstate: sale.is_interstate,
    lines: items.map((i: any) => ({
      name: i.name,
      hsn: i.hsn_code,
      unit: i.unit,
      qtyMilli: qtyToMilli(i.qty),
      unitPricePaise: p(i.unit_price),
      taxRateBp: rateToBp(i.tax_rate),
      amounts: {
        gross: p(i.gross_amount), discount: p(i.discount_amount), taxable: p(i.taxable_value),
        cgst: p(i.cgst), sgst: p(i.sgst), igst: p(i.igst),
        tax: p(i.cgst) + p(i.sgst) + p(i.igst), total: p(i.line_total),
      },
    })),
    totals: {
      gross: p(sale.gross_total), discount: p(sale.discount_total), taxable: p(sale.taxable_total),
      cgst: p(sale.cgst_total), sgst: p(sale.sgst_total), igst: p(sale.igst_total), tax: p(sale.tax_total),
      roundOff: p(sale.round_off), grand: p(sale.grand_total),
    },
    payments: (sale.payments ?? [])
      .filter((x: any) => x.kind !== "refund")
      .map((x: any) => ({ method: x.method, amountPaise: p(x.amount) })),
    paidPaise: p(sale.paid_total),
    duePaise: p(sale.due_amount),
    note: sale.note,
  };
}

const IST = "Asia/Kolkata";
export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short", year: "numeric" });
/** Today's calendar date in India as YYYY-MM-DD, optionally shifted by days. */
export function istDate(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(d);
}
/** Short reference shown on a bill before the server has assigned its invoice number. */
export const billRef = (id: string): string => id.slice(0, 8).toUpperCase();
