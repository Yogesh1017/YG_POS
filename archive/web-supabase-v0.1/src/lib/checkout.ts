import { db } from "./db";
import { milliToDecimal, paiseToDecimal } from "./money";
import { computeCart, type CartCustomer, type CartLine } from "@/stores/cart";
import type { Business, InvoiceData, LocalSale, PaymentMethod, SalePayload } from "./types";

export interface CheckoutInput {
  business: Business;
  cashier: string;
  lines: CartLine[];
  billDiscountPaise: number;
  customer: CartCustomer | null;
  note: string;
  payments: { method: PaymentMethod; amountPaise: number; reference?: string }[];
  /** Cash handed over, when more than the cash amount due (change is given back). */
  tenderedPaise?: number;
}

/** Thrown for problems the cashier can fix at the counter. */
export class CheckoutError extends Error {}

/**
 * Record a sale on this device. This never needs the network: the sale is written to
 * IndexedDB (durably, in one transaction with the local stock change) and uploaded by sync.
 */
export async function recordSale(input: CheckoutInput): Promise<LocalSale> {
  const { business, lines, customer } = input;
  if (lines.length === 0) throw new CheckoutError("Add at least one item to the bill.");
  const { inputs, totals, interstate } = computeCart(lines, input.billDiscountPaise, business, customer);
  const payments = input.payments.filter((p) => p.amountPaise > 0);
  const paid = payments.reduce((a, p) => a + p.amountPaise, 0);
  if (paid > totals.grand) throw new CheckoutError("Payments add up to more than the bill total.");
  const due = totals.grand - paid;
  if (due > 0 && !customer?.id) throw new CheckoutError("Select a saved customer to sell on credit.");

  const id = crypto.randomUUID();
  const soldAt = new Date().toISOString();
  const payload: SalePayload = {
    id,
    business_id: business.id,
    sold_at: soldAt,
    customer_id: customer?.id ?? null,
    customer_name: customer?.name.trim() || null,
    customer_phone: customer?.phone.trim() || null,
    customer_gstin: customer?.gstin.trim().toUpperCase() || null,
    place_of_supply: customer?.stateCode ?? null,
    note: input.note.trim() || null,
    client_total: paiseToDecimal(totals.grand),
    items: lines.map((l, i) => ({
      product_id: l.productId,
      qty: milliToDecimal(l.qtyMilli),
      unit_price: paiseToDecimal(l.unitPricePaise),
      discount: paiseToDecimal(inputs[i].discountPaise),
      tax_rate: (inputs[i].taxRateBp / 100).toFixed(2),
      price_includes_tax: l.priceIncludesTax,
    })),
    payments: payments.map((p) => ({ method: p.method, amount: paiseToDecimal(p.amountPaise), reference: p.reference?.trim() || null })),
  };
  const { lines: lineAmounts, ...billTotals } = totals;
  const cashPaid = payments.filter((p) => p.method === "cash").reduce((a, p) => a + p.amountPaise, 0);
  const invoice: InvoiceData = {
    id,
    invoiceNo: null,
    status: "completed",
    soldAt,
    cashier: input.cashier,
    customer: { name: payload.customer_name, phone: payload.customer_phone, gstin: payload.customer_gstin },
    placeOfSupply: customer?.stateCode ?? business.state_code,
    interstate,
    lines: lines.map((l, i) => ({
      name: l.name, hsn: l.hsn, unit: l.unit, qtyMilli: l.qtyMilli, unitPricePaise: l.unitPricePaise,
      taxRateBp: inputs[i].taxRateBp, amounts: lineAmounts[i],
    })),
    totals: billTotals,
    payments: payments.map((p) => ({ method: p.method, amountPaise: p.amountPaise })),
    paidPaise: paid,
    duePaise: due,
    tenderedPaise: input.tenderedPaise,
    changePaise: input.tenderedPaise && input.tenderedPaise > cashPaid ? input.tenderedPaise - cashPaid : undefined,
    note: payload.note,
  };
  const sale: LocalSale = {
    id, business_id: business.id, status: "pending", sold_at: soldAt, payload, invoice,
    invoice_no: null, error: null, attempts: 0, synced_at: null,
  };

  await db.transaction("rw", db.sales, db.products, db.customers, async () => {
    await db.sales.add(sale);
    for (const l of lines) {
      const p = await db.products.get(l.productId);
      if (p?.track_stock) await db.products.update(p.id, { stock_qty: (Math.round(p.stock_qty * 1000) - l.qtyMilli) / 1000 });
    }
    if (due > 0 && customer?.id) {
      const c = await db.customers.get(customer.id);
      if (c) await db.customers.update(c.id, { balance: (Math.round(c.balance * 100) + due) / 100 });
    }
  });
  return sale;
}
