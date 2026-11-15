"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { stateName } from "@/lib/gst";
import { PAYMENT_LABELS, billRef, formatDateTime } from "@/lib/invoice";
import { formatPaise, formatQty } from "@/lib/money";
import type { Business, InvoiceData } from "@/lib/types";

export type Paper = "58mm" | "80mm" | "a4";
const PAPER_KEY = "ygpos-paper";
const paperListeners = new Set<() => void>();

/** Paper size is a per-device choice (each till has its own printer), so it lives in localStorage. */
export function usePaper(): [Paper, (p: Paper) => void] {
  const paper = useSyncExternalStore(
    (cb) => { paperListeners.add(cb); return () => paperListeners.delete(cb); },
    () => (localStorage.getItem(PAPER_KEY) as Paper | null) ?? "80mm",
    () => "80mm" as Paper,
  );
  return [paper, (p) => { localStorage.setItem(PAPER_KEY, p); paperListeners.forEach((l) => l()); }];
}

function gstSummary(inv: InvoiceData) {
  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>();
  for (const l of inv.lines) {
    const r = byRate.get(l.taxRateBp) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 };
    r.taxable += l.amounts.taxable; r.cgst += l.amounts.cgst; r.sgst += l.amounts.sgst; r.igst += l.amounts.igst;
    byRate.set(l.taxRateBp, r);
  }
  return [...byRate.entries()].sort((a, b) => a[0] - b[0]).map(([bp, v]) => ({ rate: bp / 100, ...v }));
}

const docTitle = (b: Business, inv: InvoiceData) => (b.gst_registered ? "TAX INVOICE" : "INVOICE") + (inv.status === "cancelled" ? " — CANCELLED" : "");

function Header({ b }: { b: Business }) {
  return (
    <>
      <div style={{ fontWeight: 700, fontSize: "1.25em" }}>{b.name}</div>
      {b.legal_name && b.legal_name !== b.name && <div>{b.legal_name}</div>}
      {(b.address || b.city) && <div>{[b.address, b.city, b.pincode].filter(Boolean).join(", ")}</div>}
      {b.phone && <div>Ph: {b.phone}</div>}
      {b.gst_registered && b.gstin && <div>GSTIN: {b.gstin}</div>}
    </>
  );
}

function Thermal({ b, inv, width }: { b: Business; inv: InvoiceData; width: string }) {
  const row = { display: "flex", justifyContent: "space-between", gap: "0.5em" } as const;
  const rule = { borderTop: "1px dashed #000", margin: "0.4em 0" } as const;
  const summary = gstSummary(inv);
  const itemsTotal = inv.totals.taxable + inv.totals.tax;
  return (
    <div style={{ width, padding: "2mm", fontFamily: "'IBM Plex Mono', monospace", fontSize: width === "48mm" ? "8.5pt" : "9.5pt", lineHeight: 1.3, color: "#000" }}>
      <div style={{ textAlign: "center" }}>
        <Header b={b} />
        <div style={{ ...rule }} />
        <div style={{ fontWeight: 700 }}>{docTitle(b, inv)}</div>
      </div>
      <div style={rule} />
      <div style={row}><span>{inv.invoiceNo ? `No: ${inv.invoiceNo}` : `Ref: ${billRef(inv.id)}`}</span></div>
      <div>{formatDateTime(inv.soldAt)}</div>
      {inv.cashier && <div>Billed by: {inv.cashier}</div>}
      {inv.customer.name && <div>Customer: {inv.customer.name}</div>}
      {inv.customer.phone && <div>Phone: {inv.customer.phone}</div>}
      {inv.customer.gstin && <div>GSTIN: {inv.customer.gstin}</div>}
      {b.gst_registered && inv.interstate && <div>Place of supply: {stateName(inv.placeOfSupply)}</div>}
      <div style={rule} />
      {inv.lines.map((l, i) => (
        <div key={i} style={{ marginBottom: "0.25em" }}>
          <div>{l.name}</div>
          <div style={row}>
            <span>{formatQty(l.qtyMilli)} {l.unit} x {formatPaise(l.unitPricePaise)}{b.gst_registered && l.taxRateBp > 0 ? ` @${l.taxRateBp / 100}%` : ""}</span>
            <span>{formatPaise(l.amounts.total)}</span>
          </div>
          {l.amounts.discount > 0 && <div style={{ fontSize: "0.9em" }}>  (less discount {formatPaise(l.amounts.discount)})</div>}
        </div>
      ))}
      <div style={rule} />
      <div style={row}><span>Items: {inv.lines.length}</span><span>{formatPaise(itemsTotal)}</span></div>
      {inv.totals.roundOff !== 0 && <div style={row}><span>Round off</span><span>{formatPaise(inv.totals.roundOff)}</span></div>}
      <div style={{ ...row, fontWeight: 700, fontSize: "1.3em", margin: "0.2em 0" }}><span>TOTAL</span><span>Rs {formatPaise(inv.totals.grand)}</span></div>
      {inv.totals.discount > 0 && <div style={row}><span>You saved</span><span>{formatPaise(inv.totals.discount)}</span></div>}
      <div style={rule} />
      {inv.payments.map((p, i) => <div key={i} style={row}><span>{PAYMENT_LABELS[p.method]}</span><span>{formatPaise(p.amountPaise)}</span></div>)}
      {inv.changePaise ? <div style={row}><span>Cash given {formatPaise(inv.tenderedPaise ?? 0)}, change</span><span>{formatPaise(inv.changePaise)}</span></div> : null}
      {inv.duePaise > 0 && <div style={{ ...row, fontWeight: 700 }}><span>BALANCE DUE</span><span>{formatPaise(inv.duePaise)}</span></div>}
      {b.gst_registered && inv.totals.tax > 0 && (
        <>
          <div style={rule} />
          <div style={{ fontSize: "0.9em" }}>
            <div style={row}><span>GST%  Taxable</span><span>{inv.interstate ? "IGST" : "CGST    SGST"}</span></div>
            {summary.map((s) => (
              <div key={s.rate} style={row}>
                <span>{s.rate}%  {formatPaise(s.taxable)}</span>
                <span>{inv.interstate ? formatPaise(s.igst) : `${formatPaise(s.cgst)}  ${formatPaise(s.sgst)}`}</span>
              </div>
            ))}
            <div style={row}><span>Total tax</span><span>{formatPaise(inv.totals.tax)}</span></div>
          </div>
        </>
      )}
      {!inv.invoiceNo && <><div style={rule} /><div style={{ fontSize: "0.9em" }}>Invoice number will be assigned when this bill is uploaded.</div></>}
      {inv.note && <><div style={rule} /><div>Note: {inv.note}</div></>}
      {b.receipt_footer && <><div style={rule} /><div style={{ textAlign: "center", whiteSpace: "pre-wrap" }}>{b.receipt_footer}</div></>}
    </div>
  );
}

function A4({ b, inv }: { b: Business; inv: InvoiceData }) {
  const cell = { border: "1px solid #999", padding: "4px 6px" } as const;
  const right = { ...cell, textAlign: "right" } as const;
  const summary = gstSummary(inv);
  return (
    <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "10pt", color: "#000", lineHeight: 1.4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "2px solid #000", paddingBottom: 8 }}>
        <div><Header b={b} /></div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontWeight: 700, fontSize: "1.3em" }}>{docTitle(b, inv)}</div>
          <div>{inv.invoiceNo ? <>No: <b>{inv.invoiceNo}</b></> : <>Ref: {billRef(inv.id)} (number pending)</>}</div>
          <div>Date: {formatDateTime(inv.soldAt)}</div>
        </div>
      </div>
      <div style={{ margin: "10px 0" }}>
        <b>Bill to:</b> {inv.customer.name ?? "Cash customer"}
        {inv.customer.phone && <> · {inv.customer.phone}</>}
        {inv.customer.gstin && <> · GSTIN {inv.customer.gstin}</>}
        {b.gst_registered && inv.placeOfSupply && <div>Place of supply: {stateName(inv.placeOfSupply)} ({inv.placeOfSupply})</div>}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ background: "#eee" }}>
            <th style={cell}>#</th><th style={{ ...cell, textAlign: "left" }}>Item</th>
            {b.gst_registered && <th style={cell}>HSN/SAC</th>}
            <th style={right}>Qty</th><th style={right}>Rate</th><th style={right}>Discount</th>
            {b.gst_registered && <><th style={right}>Taxable</th><th style={right}>GST %</th><th style={right}>GST</th></>}
            <th style={right}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={i}>
              <td style={{ ...cell, textAlign: "center" }}>{i + 1}</td><td style={cell}>{l.name}</td>
              {b.gst_registered && <td style={{ ...cell, textAlign: "center" }}>{l.hsn ?? ""}</td>}
              <td style={right}>{formatQty(l.qtyMilli)} {l.unit}</td><td style={right}>{formatPaise(l.unitPricePaise)}</td>
              <td style={right}>{l.amounts.discount ? formatPaise(l.amounts.discount) : ""}</td>
              {b.gst_registered && <><td style={right}>{formatPaise(l.amounts.taxable)}</td><td style={right}>{l.taxRateBp / 100}</td><td style={right}>{formatPaise(l.amounts.tax)}</td></>}
              <td style={right}>{formatPaise(l.amounts.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 24, marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          {b.gst_registered && inv.totals.tax > 0 && (
            <table style={{ borderCollapse: "collapse", fontSize: "0.9em" }}>
              <thead><tr style={{ background: "#eee" }}><th style={cell}>GST %</th><th style={right}>Taxable</th>{inv.interstate ? <th style={right}>IGST</th> : <><th style={right}>CGST</th><th style={right}>SGST</th></>}</tr></thead>
              <tbody>{summary.map((s) => (
                <tr key={s.rate}><td style={{ ...cell, textAlign: "center" }}>{s.rate}</td><td style={right}>{formatPaise(s.taxable)}</td>
                  {inv.interstate ? <td style={right}>{formatPaise(s.igst)}</td> : <><td style={right}>{formatPaise(s.cgst)}</td><td style={right}>{formatPaise(s.sgst)}</td></>}</tr>
              ))}</tbody>
            </table>
          )}
          {inv.note && <p style={{ marginTop: 8 }}>Note: {inv.note}</p>}
        </div>
        <table style={{ borderCollapse: "collapse", minWidth: "42%" }}>
          <tbody>
            {b.gst_registered && <tr><td style={cell}>Taxable value</td><td style={right}>{formatPaise(inv.totals.taxable)}</td></tr>}
            {b.gst_registered && !inv.interstate && <><tr><td style={cell}>CGST</td><td style={right}>{formatPaise(inv.totals.cgst)}</td></tr><tr><td style={cell}>SGST</td><td style={right}>{formatPaise(inv.totals.sgst)}</td></tr></>}
            {b.gst_registered && inv.interstate && <tr><td style={cell}>IGST</td><td style={right}>{formatPaise(inv.totals.igst)}</td></tr>}
            {inv.totals.discount > 0 && <tr><td style={cell}>Discount given</td><td style={right}>{formatPaise(inv.totals.discount)}</td></tr>}
            {inv.totals.roundOff !== 0 && <tr><td style={cell}>Round off</td><td style={right}>{formatPaise(inv.totals.roundOff)}</td></tr>}
            <tr style={{ fontWeight: 700, fontSize: "1.15em" }}><td style={cell}>Total</td><td style={right}>₹{formatPaise(inv.totals.grand)}</td></tr>
            {inv.payments.map((p, i) => <tr key={i}><td style={cell}>Paid — {PAYMENT_LABELS[p.method]}</td><td style={right}>{formatPaise(p.amountPaise)}</td></tr>)}
            {inv.duePaise > 0 && <tr style={{ fontWeight: 700 }}><td style={cell}>Balance due</td><td style={right}>{formatPaise(inv.duePaise)}</td></tr>}
          </tbody>
        </table>
      </div>
      {b.receipt_footer && <p style={{ marginTop: 24, textAlign: "center", whiteSpace: "pre-wrap" }}>{b.receipt_footer}</p>}
      <p style={{ marginTop: 32, textAlign: "right" }}>For {b.legal_name || b.name}<br /><br /><br />Authorised signatory</p>
    </div>
  );
}

export function Receipt({ business, invoice, paper }: { business: Business; invoice: InvoiceData; paper: Paper }) {
  if (paper === "a4") return <A4 b={business} inv={invoice} />;
  return <Thermal b={business} inv={invoice} width={paper === "58mm" ? "48mm" : "72mm"} />;
}

/**
 * Renders the invoice into #print-root (hidden on screen, the only thing visible in print)
 * and opens the browser print dialog. The browser — not this app — talks to the printer.
 */
export function PrintJob({ business, invoice, paper, onDone }: { business: Business; invoice: InvoiceData; paper: Paper; onDone: () => void }) {
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
    const done = () => onDone();
    window.addEventListener("afterprint", done, { once: true });
    // Let the portal paint (and fonts settle) before the dialog snapshots the page.
    const t = window.setTimeout(() => window.print(), 80);
    return () => { window.clearTimeout(t); window.removeEventListener("afterprint", done); };
  }, [root, onDone]);
  if (!root) return null;
  return createPortal(
    <>
      <style>{paper === "a4" ? "@page { size: A4; margin: 12mm; }" : "@page { margin: 0; }"}</style>
      <Receipt business={business} invoice={invoice} paper={paper} />
    </>,
    root,
  );
}
