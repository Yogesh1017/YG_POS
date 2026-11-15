"use client";
// Printable documents: wholesale tax invoice (A4), thermal receipt, credit note, account statement.
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { formatDate, formatDateTime } from "@/lib/api";
import { stateName } from "@/lib/gst";
import { formatPaise } from "@/lib/money";
import { desktop, type Paper } from "@/lib/print";
import { METHOD_LABELS, type Ledger, type Sale, type Settings } from "@/lib/types";
import { formatQtyM } from "@/lib/units";

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
const below100 = (n: number): string => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`);
const below1000 = (n: number): string => (n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? " " + below100(n % 100) : ""}` : below100(n));
/** 12345650 paise -> "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Fifty Paise Only" */
export function amountInWords(paise: number): string {
  let rupees = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rupees) parts.push(below1000(rupees));
  const main = parts.length ? parts.join(" ") : "Zero";
  return `Rupees ${main}${p ? ` and ${below100(p)} Paise` : ""} Only`;
}

function gstSummary(sale: Sale) {
  const by = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of sale.items) {
    const r = by.get(l.tax_rate_bp) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.taxable; r.cgst += l.cgst; r.sgst += l.sgst; r.igst += l.igst;
    by.set(l.tax_rate_bp, r);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([bp, v]) => ({ rate: bp / 100, ...v }));
}
const qtyText = (qtyM: number, unit: string) => `${formatQtyM(qtyM)} ${unit}`;

function Letterhead({ s, align = "left" }: { s: Settings; align?: "left" | "center" }) {
  return (
    <div style={{ textAlign: align }}>
      <div style={{ fontWeight: 700, fontSize: "1.35em" }}>{s.business_name}</div>
      {s.legal_name && s.legal_name !== s.business_name && <div>{s.legal_name}</div>}
      {(s.address || s.city) && <div>{[s.address, s.city, s.pincode].filter(Boolean).join(", ")}</div>}
      {(s.phone || s.email) && <div>{[s.phone && `Ph: ${s.phone}`, s.email].filter(Boolean).join(" · ")}</div>}
      {!!s.gst_registered && s.gstin && <div>GSTIN: <b>{s.gstin}</b>{s.state_code && ` · State: ${stateName(s.state_code)} (${s.state_code})`}</div>}
    </div>
  );
}

const cell = { border: "1px solid #888", padding: "3px 6px", verticalAlign: "top" } as const;
const right = { ...cell, textAlign: "right", whiteSpace: "nowrap" } as const;
const center = { ...cell, textAlign: "center" } as const;
const sheet = { fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "9.5pt", color: "#000", lineHeight: 1.35 } as const;

export function InvoiceA4({ sale, settings }: { sale: Sale; settings: Settings }) {
  const gst = !!settings.gst_registered;
  const summary = gstSummary(sale);
  return (
    <div style={sheet} data-doc="invoice-a4">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, borderBottom: "2px solid #000", paddingBottom: 8 }}>
        <Letterhead s={settings} />
        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          <div style={{ fontWeight: 700, fontSize: "1.4em" }}>{gst ? "TAX INVOICE" : "INVOICE"}</div>
          {sale.status === "cancelled" && <div style={{ fontWeight: 700, border: "2px solid #000", padding: "1px 8px", display: "inline-block", margin: "2px 0" }}>CANCELLED</div>}
          <div>Invoice no: <b>{sale.invoice_no}</b></div>
          <div>Date: <b>{formatDate(sale.sold_on)}</b></div>
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, margin: "10px 0" }}>
        <div>
          <div style={{ fontSize: "0.85em", textTransform: "uppercase", letterSpacing: "0.04em" }}>Billed to</div>
          <div style={{ fontWeight: 700 }}>{sale.customer_name ?? "Cash sale"}</div>
          {sale.customer_address && <div>{sale.customer_address}</div>}
          {sale.customer_phone && <div>Ph: {sale.customer_phone}</div>}
          {sale.customer_gstin && <div>GSTIN: <b>{sale.customer_gstin}</b></div>}
        </div>
        {gst && sale.place_of_supply && <div style={{ textAlign: "right" }}>Place of supply: {stateName(sale.place_of_supply)} ({sale.place_of_supply})</div>}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#eee" }}>
            <th style={center}>#</th><th style={{ ...cell, textAlign: "left" }}>Description</th>{gst && <th style={center}>HSN</th>}
            <th style={right}>Quantity</th><th style={right}>Rate</th><th style={right}>Discount</th>
            {gst && <><th style={right}>Taxable</th><th style={right}>GST %</th><th style={right}>GST</th></>}<th style={right}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((l) => (
            <tr key={l.id}>
              <td style={center}>{l.line_no}</td><td style={cell}>{l.name}</td>{gst && <td style={center}>{l.hsn_code ?? ""}</td>}
              <td style={right}>{qtyText(l.qty_m, l.unit_name)}</td><td style={right}>{formatPaise(l.unit_price)}</td><td style={right}>{l.discount ? formatPaise(l.discount) : ""}</td>
              {gst && <><td style={right}>{formatPaise(l.taxable)}</td><td style={right}>{l.tax_rate_bp / 100}</td><td style={right}>{formatPaise(l.cgst + l.sgst + l.igst)}</td></>}
              <td style={right}>{formatPaise(l.line_total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 20, marginTop: 10, breakInside: "avoid" }}>
        <div style={{ flex: 1 }}>
          <div><b>Amount in words:</b> {amountInWords(sale.grand_total)}</div>
          {gst && sale.tax_total > 0 && (
            <table style={{ borderCollapse: "collapse", fontSize: "0.9em", marginTop: 8 }}>
              <thead><tr style={{ background: "#eee" }}><th style={center}>GST %</th><th style={right}>Taxable</th>{sale.is_interstate ? <th style={right}>IGST</th> : <><th style={right}>CGST</th><th style={right}>SGST</th></>}</tr></thead>
              <tbody>{summary.map((r) => (
                <tr key={r.rate}><td style={center}>{r.rate}</td><td style={right}>{formatPaise(r.taxable)}</td>
                  {sale.is_interstate ? <td style={right}>{formatPaise(r.igst)}</td> : <><td style={right}>{formatPaise(r.cgst)}</td><td style={right}>{formatPaise(r.sgst)}</td></>}</tr>
              ))}</tbody>
            </table>
          )}
          {sale.note && <div style={{ marginTop: 8 }}>Note: {sale.note}</div>}
          {settings.bank_details && <div style={{ marginTop: 8, whiteSpace: "pre-wrap" }}><b>Bank details</b>{"\n"}{settings.bank_details}</div>}
        </div>
        <table style={{ borderCollapse: "collapse", minWidth: "40%", alignSelf: "flex-start" }}>
          <tbody>
            {sale.discount_total > 0 && <tr><td style={cell}>Discount given</td><td style={right}>{formatPaise(sale.discount_total)}</td></tr>}
            <tr><td style={cell}>{gst ? "Taxable value" : "Sub total"}</td><td style={right}>{formatPaise(sale.taxable_total)}</td></tr>
            {gst && !sale.is_interstate && <><tr><td style={cell}>CGST</td><td style={right}>{formatPaise(sale.cgst_total)}</td></tr><tr><td style={cell}>SGST</td><td style={right}>{formatPaise(sale.sgst_total)}</td></tr></>}
            {gst && !!sale.is_interstate && <tr><td style={cell}>IGST</td><td style={right}>{formatPaise(sale.igst_total)}</td></tr>}
            {sale.round_off !== 0 && <tr><td style={cell}>Round off</td><td style={right}>{formatPaise(sale.round_off)}</td></tr>}
            <tr style={{ fontWeight: 700, fontSize: "1.15em" }}><td style={cell}>Total</td><td style={right}>₹{formatPaise(sale.grand_total)}</td></tr>
            {sale.status === "completed" && <>
              <tr><td style={cell}>Received</td><td style={right}>{formatPaise(sale.paid_total)}</td></tr>
              <tr style={{ fontWeight: 700 }}><td style={cell}>Balance due</td><td style={right}>{formatPaise(sale.due_amount)}</td></tr>
            </>}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 20, marginTop: 18, breakInside: "avoid" }}>
        <div style={{ flex: 1, fontSize: "0.9em", whiteSpace: "pre-wrap" }}>{settings.invoice_terms && <><b>Terms</b>{"\n"}{settings.invoice_terms}</>}</div>
        <div style={{ textAlign: "right" }}>For {settings.legal_name || settings.business_name}<br /><br /><br />Authorised signatory</div>
      </div>
    </div>
  );
}

export function ReceiptThermal({ sale, settings, width }: { sale: Sale; settings: Settings; width: "80mm" | "58mm" }) {
  const row = { display: "flex", justifyContent: "space-between", gap: "0.5em" } as const;
  const rule = { borderTop: "1px dashed #000", margin: "0.4em 0" } as const;
  const gst = !!settings.gst_registered;
  return (
    <div data-doc="receipt-thermal" style={{ width: width === "58mm" ? "48mm" : "72mm", padding: "2mm", fontFamily: "'IBM Plex Mono', monospace", fontSize: width === "58mm" ? "8.5pt" : "9.5pt", lineHeight: 1.3, color: "#000" }}>
      <Letterhead s={settings} align="center" />
      <div style={rule} />
      <div style={{ textAlign: "center", fontWeight: 700 }}>{gst ? "TAX INVOICE" : "INVOICE"}{sale.status === "cancelled" ? " — CANCELLED" : ""}</div>
      <div style={rule} />
      <div>No: {sale.invoice_no}</div>
      <div>{formatDateTime(sale.sold_at)}</div>
      <div>To: {sale.customer_name ?? "Cash sale"}</div>
      {sale.customer_gstin && <div>GSTIN: {sale.customer_gstin}</div>}
      <div style={rule} />
      {sale.items.map((l) => (
        <div key={l.id} style={{ marginBottom: "0.25em" }}>
          <div>{l.name}</div>
          <div style={row}><span>{qtyText(l.qty_m, l.unit_name)} x {formatPaise(l.unit_price)}{gst && l.tax_rate_bp ? ` @${l.tax_rate_bp / 100}%` : ""}</span><span>{formatPaise(l.line_total)}</span></div>
          {l.discount > 0 && <div style={{ fontSize: "0.9em" }}>  (less discount {formatPaise(l.discount)})</div>}
        </div>
      ))}
      <div style={rule} />
      {gst && <div style={row}><span>Taxable</span><span>{formatPaise(sale.taxable_total)}</span></div>}
      {gst && (sale.is_interstate ? <div style={row}><span>IGST</span><span>{formatPaise(sale.igst_total)}</span></div>
        : <><div style={row}><span>CGST</span><span>{formatPaise(sale.cgst_total)}</span></div><div style={row}><span>SGST</span><span>{formatPaise(sale.sgst_total)}</span></div></>)}
      {sale.round_off !== 0 && <div style={row}><span>Round off</span><span>{formatPaise(sale.round_off)}</span></div>}
      <div style={{ ...row, fontWeight: 700, fontSize: "1.3em", margin: "0.2em 0" }}><span>TOTAL</span><span>Rs {formatPaise(sale.grand_total)}</span></div>
      {sale.payments.filter((p) => p.kind !== "refund").map((p) => <div key={p.id} style={row}><span>{METHOD_LABELS[p.method]}</span><span>{formatPaise(p.amount)}</span></div>)}
      {sale.due_amount > 0 && <div style={{ ...row, fontWeight: 700 }}><span>BALANCE DUE</span><span>{formatPaise(sale.due_amount)}</span></div>}
      {settings.receipt_footer && <><div style={rule} /><div style={{ textAlign: "center" }}>{settings.receipt_footer}</div></>}
    </div>
  );
}

export interface CreditNoteData {
  credit_note_no: string; returned_on: string; reason: string | null; total: number; taxable_total: number; tax_total: number; due_reduced: number; refund_paid: number;
  items: { id: number; name: string; base_unit: string; base_qty_m: number; disposition: string; taxable: number; tax: number; amount: number; hsn_code: string | null; tax_rate_bp: number }[];
}
export function CreditNoteA4({ note, sale, settings }: { note: CreditNoteData; sale: Sale; settings: Settings }) {
  return (
    <div style={sheet} data-doc="credit-note">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, borderBottom: "2px solid #000", paddingBottom: 8 }}>
        <Letterhead s={settings} />
        <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          <div style={{ fontWeight: 700, fontSize: "1.4em" }}>CREDIT NOTE</div>
          <div>No: <b>{note.credit_note_no}</b></div><div>Date: <b>{formatDate(note.returned_on)}</b></div>
          <div>Against invoice: <b>{sale.invoice_no}</b> ({formatDate(sale.sold_on)})</div>
        </div>
      </div>
      <div style={{ margin: "10px 0" }}><b>{sale.customer_name ?? "Cash sale"}</b>{sale.customer_gstin && <> · GSTIN {sale.customer_gstin}</>}{note.reason && <div>Reason: {note.reason}</div>}</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ background: "#eee" }}><th style={{ ...cell, textAlign: "left" }}>Goods returned</th><th style={center}>HSN</th><th style={right}>Quantity</th><th style={right}>Taxable</th><th style={right}>GST %</th><th style={right}>GST</th><th style={right}>Amount</th></tr></thead>
        <tbody>{note.items.map((i) => (
          <tr key={i.id}><td style={cell}>{i.name}</td><td style={center}>{i.hsn_code ?? ""}</td><td style={right}>{qtyText(i.base_qty_m, i.base_unit)}</td><td style={right}>{formatPaise(i.taxable)}</td><td style={right}>{i.tax_rate_bp / 100}</td><td style={right}>{formatPaise(i.tax)}</td><td style={right}>{formatPaise(i.amount)}</td></tr>
        ))}</tbody>
      </table>
      <table style={{ borderCollapse: "collapse", marginTop: 10, marginLeft: "auto", minWidth: "40%" }}><tbody>
        <tr style={{ fontWeight: 700 }}><td style={cell}>Credit note value</td><td style={right}>₹{formatPaise(note.total)}</td></tr>
        {note.due_reduced > 0 && <tr><td style={cell}>Adjusted against balance due</td><td style={right}>{formatPaise(note.due_reduced)}</td></tr>}
        {note.refund_paid > 0 && <tr><td style={cell}>Refunded</td><td style={right}>{formatPaise(note.refund_paid)}</td></tr>}
      </tbody></table>
      <p style={{ marginTop: 32, textAlign: "right" }}>For {settings.legal_name || settings.business_name}<br /><br /><br />Authorised signatory</p>
    </div>
  );
}

export function StatementA4({ title, party, ledger, settings, from, to }: { title: string; party: { name: string; phone?: string | null; gstin?: string | null }; ledger: Ledger; settings: Settings; from?: string; to?: string }) {
  return (
    <div style={sheet} data-doc="statement">
      <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "2px solid #000", paddingBottom: 8 }}>
        <Letterhead s={settings} />
        <div style={{ textAlign: "right" }}><div style={{ fontWeight: 700, fontSize: "1.3em" }}>{title}</div>{from && to && <div>{formatDate(from)} to {formatDate(to)}</div>}</div>
      </div>
      <div style={{ margin: "10px 0" }}><b>{party.name}</b>{party.phone && <> · {party.phone}</>}{party.gstin && <> · GSTIN {party.gstin}</>}</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr style={{ background: "#eee" }}><th style={{ ...cell, textAlign: "left" }}>Date</th><th style={{ ...cell, textAlign: "left" }}>Particulars</th><th style={right}>Debit</th><th style={right}>Credit</th><th style={right}>Balance</th></tr></thead>
        <tbody>
          {ledger.opening !== 0 && <tr><td style={cell} /><td style={cell}>Balance brought forward</td><td style={right} /><td style={right} /><td style={right}>{formatPaise(ledger.opening)}</td></tr>}
          {ledger.entries.map((e, i) => (
            <tr key={i}><td style={{ ...cell, whiteSpace: "nowrap" }}>{formatDate(e.date)}</td><td style={cell}>{e.type}{e.ref ? ` — ${e.ref}` : ""}</td><td style={right}>{e.debit ? formatPaise(e.debit) : ""}</td><td style={right}>{e.credit ? formatPaise(e.credit) : ""}</td><td style={right}>{formatPaise(e.balance)}</td></tr>
          ))}
          <tr style={{ fontWeight: 700 }}><td style={cell} /><td style={cell}>Closing balance</td><td style={right} /><td style={right} /><td style={right}>₹{formatPaise(ledger.closing)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

export interface PrintRequest { paper: Paper; mode: "print" | "pdf"; filename?: string; printer?: string; silent?: boolean; content: ReactNode }

/**
 * Renders a document into #print-root (hidden on screen, the only thing visible when printing) and
 * sends it to the printer or to a PDF file. One job at a time; `onDone` fires when it has finished.
 */
export function PrintJob({ job, onDone }: { job: PrintRequest; onDone: () => void }) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let el = document.getElementById("print-root");
    if (!el) {
      el = document.createElement("div");
      el.id = "print-root";
      document.body.appendChild(el);
    }
    setRoot(el);
  }, []);
  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const finish = () => { if (!cancelled) { cancelled = true; onDone(); } };
    // Give the document a moment to lay out and load fonts before it is captured.
    const timer = window.setTimeout(async () => {
      const d = desktop();
      try {
        if (d && job.mode === "pdf") {
          const r = await d.savePdf({ paper: job.paper, filename: job.filename ?? "document.pdf" });
          if (r.ok && r.file) toast.success(`Saved ${r.file}`);
          else if (r.error) toast.error(`Could not save the PDF: ${r.error}`);
        } else if (d) {
          const r = await d.print({ paper: job.paper, printer: job.printer, silent: job.silent });
          if (!r.ok && r.error && r.error !== "cancelled") toast.error(`Printing failed: ${r.error}`);
        } else {
          window.addEventListener("afterprint", finish, { once: true });
          window.print();
          return;
        }
      } catch (e) {
        toast.error(`Printing failed: ${e instanceof Error ? e.message : e}`);
      }
      finish();
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener("afterprint", finish); };
  }, [root, job, onDone]);
  if (!root) return null;
  return createPortal(
    <>
      <style>{job.paper === "a4" ? "@page { size: A4; margin: 10mm; }" : "@page { margin: 0; }"}</style>
      {job.content}
    </>,
    root,
  );
}
