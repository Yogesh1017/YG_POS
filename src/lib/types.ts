// Shapes returned by the core. Flags are 0/1; money is paise; *_m quantities are thousandths.
export type Role = "owner" | "manager" | "cashier";
export type Method = "cash" | "upi" | "card" | "bank" | "cheque" | "other";
export const METHOD_LABELS: Record<Method, string> = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", cheque: "Cheque", other: "Other" };

export interface User { id: number; username: string; display_name: string; role: Role; is_active?: number }
export interface Settings {
  business_name: string; legal_name: string | null; phone: string | null; email: string | null; address: string | null; city: string | null; pincode: string | null;
  state_code: string | null; gst_registered: number; gstin: string | null; default_tax_rate_bp: number; prices_include_tax: number; round_off_total: number;
  invoice_prefix: string; invoice_terms: string | null; bank_details: string | null; receipt_footer: string | null; setup_complete: number;
}
export interface Tier { min_qty_m: number; price: number }
export interface Unit {
  id: number; product_id: number; name: string; factor_m: number; sale_price: number; is_base: number;
  is_default_sale: number; is_default_purchase: number; is_active: number; tiers: Tier[];
}
export interface Product {
  id: number; name: string; brand_id: number | null; category_id: number | null; brand_name: string | null; category_name: string | null;
  flavour: string | null; pack_size: string | null; sku: string | null; barcode: string | null; hsn_code: string | null;
  tax_rate_bp: number; price_includes_tax: number; base_unit: string; qty_decimals: 0 | 3; track_expiry: number; low_stock_m: number;
  cost4: number; shortfall_m: number; description: string | null; is_active: number;
  on_hand_m: number; expired_m: number; sellable_m: number; units: Unit[];
}
export interface Named { id: number; name: string }
export interface Customer {
  id: number; name: string; contact_person: string | null; phone: string | null; gstin: string | null; state_code: string | null; address: string | null; city: string | null;
  notes: string | null; credit_limit: number | null; opening_balance: number; opening_due: number; balance: number; is_active: number;
}
export interface Supplier {
  id: number; name: string; contact_person: string | null; phone: string | null; gstin: string | null; state_code: string | null; address: string | null;
  notes: string | null; opening_balance: number; opening_due: number; balance: number; is_active: number;
}
export interface SaleItem {
  id: number; line_no: number; product_id: number; unit_id: number; name: string; unit_name: string; factor_m: number; hsn_code: string | null;
  qty_m: number; base_qty_m: number; unit_price: number; list_price: number; price_source: string; price_includes_tax: number;
  gross: number; discount: number; tax_rate_bp: number; taxable: number; cgst: number; sgst: number; igst: number; line_total: number; cost_total: number; returned_base_m: number;
}
export interface Payment { id: number; kind: string; method: Method; amount: number; reference: string | null; paid_on: string; note: string | null }
export interface SaleReturn { id: number; credit_note_no: string; reason: string | null; total: number; taxable_total: number; tax_total: number; due_reduced: number; refund_paid: number; refund_method: Method | null; returned_on: string }
export interface Sale {
  id: number; invoice_no: string; status: "completed" | "cancelled"; customer_id: number | null; customer_name: string | null; customer_phone: string | null;
  customer_gstin: string | null; customer_address: string | null; place_of_supply: string | null; is_interstate: number;
  gross_total: number; discount_total: number; taxable_total: number; cgst_total: number; sgst_total: number; igst_total: number; tax_total: number;
  round_off: number; grand_total: number; paid_total: number; due_amount: number; returned_total: number; note: string | null; sold_on: string; sold_at: string;
  cashier: string | null; cancelled_at: string | null; cancel_reason: string | null;
  items: SaleItem[]; payments: Payment[]; returns: SaleReturn[];
}
export interface LedgerEntry { date: string; type: string; ref: string; debit: number; credit: number; balance: number }
export interface Ledger { opening: number; closing: number; entries: LedgerEntry[] }
