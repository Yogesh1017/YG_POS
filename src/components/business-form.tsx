"use client";
import { useState } from "react";
import { GstinInput, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { GST_STATES } from "@/lib/gst";
import type { Settings } from "@/lib/types";

export interface BusinessValues {
  business_name: string; legal_name: string; phone: string; email: string; address: string; city: string; pincode: string; state_code: string;
  gst_registered: boolean; gstin: string; default_tax_rate: string; prices_include_tax: boolean; round_off_total: boolean;
  invoice_prefix: string; invoice_terms: string; bank_details: string; receipt_footer: string;
}
export const businessDefaults = (s?: Settings | null): BusinessValues => ({
  business_name: s?.business_name ?? "", legal_name: s?.legal_name ?? "", phone: s?.phone ?? "", email: s?.email ?? "", address: s?.address ?? "",
  city: s?.city ?? "", pincode: s?.pincode ?? "", state_code: s?.state_code ?? "", gst_registered: !!s?.gst_registered, gstin: s?.gstin ?? "",
  default_tax_rate: String((s?.default_tax_rate_bp ?? 0) / 100), prices_include_tax: !!s?.prices_include_tax, round_off_total: s ? !!s.round_off_total : true,
  invoice_prefix: s?.invoice_prefix ?? "INV", invoice_terms: s?.invoice_terms ?? "", bank_details: s?.bank_details ?? "", receipt_footer: s?.receipt_footer ?? "",
});
/** What the core expects. Validation happens there; its message is shown to the user. */
export const businessPayload = (v: BusinessValues) => ({
  ...v, state_code: v.state_code || null, default_tax_rate_bp: Math.round(Number(v.default_tax_rate || 0) * 100), default_tax_rate: undefined,
});

export function useBusinessForm(initial: BusinessValues) {
  const [v, setV] = useState(initial);
  const set = <K extends keyof BusinessValues>(k: K, value: BusinessValues[K]) => setV((s) => ({ ...s, [k]: value }));
  return { v, set };
}

/** Business profile, GST and invoice settings. Used at first-run setup and in Settings. */
export function BusinessFields({ v, set, full }: { v: BusinessValues; set: <K extends keyof BusinessValues>(k: K, value: BusinessValues[K]) => void; full: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold">Business details <span className="font-normal text-muted">— printed on every invoice</span></legend>
        <Field label="Business name">{(p) => <Input {...p} value={v.business_name} onChange={(e) => set("business_name", e.target.value)} />}</Field>
        <Field label="Phone">{(p) => <Input {...p} inputMode="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
        <Field label="Address" className="sm:col-span-2">{(p) => <Input {...p} value={v.address} onChange={(e) => set("address", e.target.value)} />}</Field>
        <Field label="City">{(p) => <Input {...p} value={v.city} onChange={(e) => set("city", e.target.value)} />}</Field>
        <Field label="PIN code">{(p) => <Input {...p} inputMode="numeric" maxLength={6} value={v.pincode} onChange={(e) => set("pincode", e.target.value)} />}</Field>
        <Field label="State">{(p) => (
          <Select {...p} value={v.state_code} onChange={(e) => set("state_code", e.target.value)}>
            <option value="">Select state</option>
            {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Email">{(p) => <Input {...p} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />}</Field>
      </fieldset>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-sm font-semibold">GST</legend>
        <Checkbox label="This business is registered for GST" hint="Leave off if you have no GSTIN. Invoices will then carry no tax." checked={v.gst_registered} onChange={(e) => set("gst_registered", e.target.checked)} />
        {v.gst_registered && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GSTIN">{(p) => <GstinInput {...p} value={v.gstin} onChange={(g) => set("gstin", g)} />}</Field>
            <Field label="Legal name (as on GST certificate)">{(p) => <Input {...p} value={v.legal_name} onChange={(e) => set("legal_name", e.target.value)} />}</Field>
            <Field label="Usual GST rate for new products (%)" hint="Each product has its own rate; confirm rates with your accountant.">{(p) => <Input {...p} className="num" inputMode="decimal" value={v.default_tax_rate} onChange={(e) => set("default_tax_rate", e.target.value)} />}</Field>
            <div className="flex items-center"><Checkbox label="My rates already include GST" hint="Off = rates are before GST and GST is added on the invoice (usual for wholesale)." checked={v.prices_include_tax} onChange={(e) => set("prices_include_tax", e.target.checked)} /></div>
          </div>
        )}
      </fieldset>
      {full && (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-3 text-sm font-semibold">Invoices</legend>
          <Field label="Invoice number prefix" hint={`Numbered like ${v.invoice_prefix || "INV"}/26-27/1, restarting each April.`}>{(p) => <Input {...p} className="num uppercase" maxLength={6} value={v.invoice_prefix} onChange={(e) => set("invoice_prefix", e.target.value.toUpperCase())} />}</Field>
          <div className="flex items-center"><Checkbox label="Round the invoice total to the nearest rupee" checked={v.round_off_total} onChange={(e) => set("round_off_total", e.target.checked)} /></div>
          <Field label="Bank details (printed on A4 invoices)">{(p) => <Textarea {...p} rows={3} value={v.bank_details} onChange={(e) => set("bank_details", e.target.value)} />}</Field>
          <Field label="Terms and conditions (printed on A4 invoices)">{(p) => <Textarea {...p} rows={3} value={v.invoice_terms} onChange={(e) => set("invoice_terms", e.target.value)} />}</Field>
          <Field label="Footer line on thermal receipts" className="sm:col-span-2">{(p) => <Input {...p} value={v.receipt_footer} onChange={(e) => set("receipt_footer", e.target.value)} />}</Field>
        </fieldset>
      )}
    </div>
  );
}
