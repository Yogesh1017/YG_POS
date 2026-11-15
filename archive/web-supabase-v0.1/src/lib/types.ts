import type { LineAmounts, SaleTotals } from "./tax";

export type Role = "owner" | "manager" | "cashier";
export type PaymentMethod = "cash" | "upi" | "card" | "other";
export type StockReason =
  | "opening" | "stock_in" | "sale" | "sale_cancel" | "sale_return" | "adjustment" | "damage" | "expiry";

export interface Business {
  id: string;
  name: string;
  legal_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  state_code: string | null;
  gst_registered: boolean;
  gstin: string | null;
  default_tax_rate: number;
  prices_include_tax: boolean;
  round_off_total: boolean;
  invoice_prefix: string;
  receipt_footer: string | null;
}

export interface Member {
  business_id: string;
  user_id: string;
  role: Role;
  display_name: string;
  email: string;
  is_active: boolean;
}

export interface Category {
  id: string;
  business_id: string;
  name: string;
}

export interface Product {
  id: string;
  business_id: string;
  category_id: string | null;
  name: string;
  sku: string | null;
  barcode: string | null;
  hsn_code: string | null;
  unit: string;
  sale_price: number;
  purchase_price: number;
  tax_rate: number;
  price_includes_tax: boolean;
  track_stock: boolean;
  stock_qty: number;
  low_stock_threshold: number;
  description: string | null;
  is_active: boolean;
}

export interface Customer {
  id: string;
  business_id: string;
  name: string;
  phone: string | null;
  gstin: string | null;
  state_code: string | null;
  address: string | null;
  balance: number;
}

/** What the create_sale() database function accepts. Decimal values travel as strings. */
export interface SalePayload {
  id: string;
  business_id: string;
  sold_at: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_gstin: string | null;
  place_of_supply: string | null;
  note: string | null;
  client_total: string;
  items: {
    product_id: string;
    qty: string;
    unit_price: string;
    discount: string;
    tax_rate: string;
    price_includes_tax: boolean;
  }[];
  payments: { method: PaymentMethod; amount: string; reference: string | null }[];
}

/** Everything needed to show or print a bill, whether it came from this device or the server. */
export interface InvoiceData {
  id: string;
  invoiceNo: string | null;
  status: "completed" | "cancelled";
  soldAt: string;
  cashier: string | null;
  customer: { name: string | null; phone: string | null; gstin: string | null };
  placeOfSupply: string | null;
  interstate: boolean;
  lines: {
    name: string;
    hsn: string | null;
    unit: string;
    qtyMilli: number;
    unitPricePaise: number;
    taxRateBp: number;
    amounts: LineAmounts;
  }[];
  totals: Omit<SaleTotals, "lines">;
  payments: { method: PaymentMethod; amountPaise: number }[];
  paidPaise: number;
  duePaise: number;
  /** Cash handed over and change returned — known only on the device that made the sale. */
  tenderedPaise?: number;
  changePaise?: number;
  note: string | null;
}

/** A sale made on this device. Kept in IndexedDB until the server confirms it (and a while after). */
export interface LocalSale {
  id: string;
  business_id: string;
  status: "pending" | "synced" | "failed";
  sold_at: string;
  payload: SalePayload;
  invoice: InvoiceData;
  invoice_no: string | null;
  error: string | null;
  attempts: number;
  synced_at: string | null;
}
