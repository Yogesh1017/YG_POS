"use client";
import { useState, type FormEvent } from "react";
import { Button, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";
import { GST_STATES } from "@/lib/gst";
import { businessSchema, fieldErrors, type BusinessForm as Values } from "@/lib/schemas";
import type { Business } from "@/lib/types";

export const businessDefaults = (b?: Business | null): Values => ({
  name: b?.name ?? "", legal_name: b?.legal_name ?? "", phone: b?.phone ?? "", email: b?.email ?? "",
  address: b?.address ?? "", city: b?.city ?? "", pincode: b?.pincode ?? "", state_code: b?.state_code ?? "",
  gst_registered: b?.gst_registered ?? false, gstin: b?.gstin ?? "", default_tax_rate: b?.default_tax_rate ?? 0,
  prices_include_tax: b?.prices_include_tax ?? true, round_off_total: b?.round_off_total ?? true,
  invoice_prefix: b?.invoice_prefix ?? "INV", receipt_footer: b?.receipt_footer ?? "",
});

/** Shop profile + tax settings. Used for first-time setup and in Settings. */
export function BusinessForm({ initial, submitLabel, onSubmit, mode }: {
  initial: Values; submitLabel: string; mode: "setup" | "edit"; onSubmit: (values: Values) => Promise<void>;
}) {
  const [v, setV] = useState<Values>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Values>(k: K, value: Values[K]) => setV((s) => ({ ...s, [k]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = businessSchema.safeParse(v);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try { await onSubmit(parsed.data); } finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold">Shop details <span className="font-normal text-muted">— printed on every bill</span></legend>
        <Field label="Shop name" error={errors.name}>{(p) => <Input {...p} value={v.name} onChange={(e) => set("name", e.target.value)} autoFocus={mode === "setup"} />}</Field>
        <Field label="Phone" error={errors.phone}>{(p) => <Input {...p} inputMode="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
        <Field label="Address" error={errors.address} className="sm:col-span-2">{(p) => <Input {...p} value={v.address} onChange={(e) => set("address", e.target.value)} />}</Field>
        <Field label="City" error={errors.city}>{(p) => <Input {...p} value={v.city} onChange={(e) => set("city", e.target.value)} />}</Field>
        <Field label="PIN code" error={errors.pincode}>{(p) => <Input {...p} inputMode="numeric" value={v.pincode} onChange={(e) => set("pincode", e.target.value)} />}</Field>
        <Field label="State" error={errors.state_code}>{(p) => (
          <Select {...p} value={v.state_code} onChange={(e) => set("state_code", e.target.value)}>
            <option value="">Select state</option>
            {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </Select>
        )}</Field>
        <Field label="Email" error={errors.email}>{(p) => <Input {...p} type="email" value={v.email} onChange={(e) => set("email", e.target.value)} />}</Field>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-sm font-semibold">Tax</legend>
        <Checkbox label="My shop is registered for GST" hint="Leave off if you do not have a GSTIN. Bills will then carry no tax." checked={v.gst_registered} onChange={(e) => set("gst_registered", e.target.checked)} />
        {v.gst_registered && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="GSTIN" error={errors.gstin}>{(p) => <Input {...p} className="num uppercase" maxLength={15} value={v.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} />}</Field>
            <Field label="Legal name (as on GST certificate)" error={errors.legal_name}>{(p) => <Input {...p} value={v.legal_name} onChange={(e) => set("legal_name", e.target.value)} />}</Field>
            <Field label="Default GST rate for new products (%)" error={errors.default_tax_rate}>{(p) => <Input {...p} type="number" min={0} max={100} step="0.01" value={v.default_tax_rate} onChange={(e) => set("default_tax_rate", e.target.value === "" ? 0 : Number(e.target.value))} />}</Field>
            <div className="flex items-end pb-2"><Checkbox label="My selling prices already include GST" hint="Default for new products; can be changed per product." checked={v.prices_include_tax} onChange={(e) => set("prices_include_tax", e.target.checked)} /></div>
          </div>
        )}
      </fieldset>

      {mode === "edit" && (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-3 text-sm font-semibold">Bills</legend>
          <Field label="Invoice number prefix" error={errors.invoice_prefix} hint={`Bills are numbered like ${v.invoice_prefix || "INV"}/26-27/1, restarting each financial year.`}>{(p) => <Input {...p} className="num uppercase" maxLength={4} value={v.invoice_prefix} onChange={(e) => set("invoice_prefix", e.target.value.toUpperCase())} />}</Field>
          <div className="flex items-center"><Checkbox label="Round bill total to the nearest rupee" checked={v.round_off_total} onChange={(e) => set("round_off_total", e.target.checked)} /></div>
          <Field label="Footer note on bills" error={errors.receipt_footer} className="sm:col-span-2">{(p) => <Textarea {...p} rows={2} placeholder="Thank you! Visit again." value={v.receipt_footer} onChange={(e) => set("receipt_footer", e.target.value)} />}</Field>
        </fieldset>
      )}
      <div><Button type="submit" variant="primary" loading={busy}>{submitLabel}</Button></div>
    </form>
  );
}
