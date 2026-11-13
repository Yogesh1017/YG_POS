"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Dialog, Field, Input, Select } from "@/components/ui";
import { db } from "@/lib/db";
import { GST_STATES } from "@/lib/gst";
import { formatINR } from "@/lib/money";
import { customerSchema, emptyToNull, fieldErrors, type CustomerForm } from "@/lib/schemas";
import { useShop } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Customer } from "@/lib/types";
import { customerToCart, useCart } from "@/stores/cart";

export const emptyCustomer: CustomerForm = { name: "", phone: "", gstin: "", state_code: "", address: "" };

/** Create or update a customer on the server and mirror it into the on-device copy. Needs a connection. */
export async function saveCustomer(businessId: string, values: CustomerForm, id?: string): Promise<Customer | null> {
  const row = {
    name: values.name, phone: emptyToNull(values.phone), gstin: emptyToNull(values.gstin),
    state_code: emptyToNull(values.state_code) ?? (values.gstin ? values.gstin.slice(0, 2) : null), address: emptyToNull(values.address),
  };
  const q = id
    ? supabase().from("customers").update(row).eq("id", id).select().single()
    : supabase().from("customers").insert({ ...row, business_id: businessId }).select().single();
  const { data, error } = await q;
  if (error) { toast.error(errorMessage(error)); return null; }
  await db.customers.put(data as Customer);
  return data as Customer;
}

export function CustomerFields({ v, set, errors, showGst }: {
  v: CustomerForm; set: <K extends keyof CustomerForm>(k: K, value: CustomerForm[K]) => void; errors: Record<string, string>; showGst: boolean;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Name" error={errors.name}>{(p) => <Input {...p} autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
      <Field label="Phone" error={errors.phone}>{(p) => <Input {...p} inputMode="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
      {showGst && <>
        <Field label="GSTIN (for business customers)" error={errors.gstin}>{(p) => <Input {...p} className="num uppercase" maxLength={15} value={v.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} />}</Field>
        <Field label="State" hint="A different state from yours means IGST is charged.">{(p) => (
          <Select {...p} value={v.state_code} onChange={(e) => set("state_code", e.target.value)}>
            <option value="">Same as shop</option>
            {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </Select>
        )}</Field>
      </>}
      <Field label="Address" className="sm:col-span-2">{(p) => <Input {...p} value={v.address} onChange={(e) => set("address", e.target.value)} />}</Field>
    </div>
  );
}

/** Choose who the bill is for: a saved customer, a one-off name, or nobody (walk-in). */
export function CustomerPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { business } = useShop();
  const cart = useCart();
  const customers = useLiveQuery(() => db.customers.where("business_id").equals(business.id).toArray(), [business.id]);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [v, setV] = useState<CustomerForm>(emptyCustomer);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (customers ?? []).filter((c) => !s || c.name.toLowerCase().includes(s) || c.phone?.includes(s)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30);
  }, [customers, q]);

  const close = () => { setQ(""); setCreating(false); setErrors({}); onClose(); };
  const pick = (c: Customer) => { cart.setCustomer(customerToCart(c)); close(); };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = customerSchema.safeParse(v);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    const saved = await saveCustomer(business.id, parsed.data);
    setBusy(false);
    if (saved) { toast.success("Customer saved"); pick(saved); }
  };

  return (
    <Dialog open={open} onClose={close} title={creating ? "New customer" : "Customer for this bill"}>
      {creating ? (
        <form onSubmit={create} noValidate className="space-y-4">
          <CustomerFields v={v} set={(k, value) => setV((s) => ({ ...s, [k]: value }))} errors={errors} showGst={business.gst_registered} />
          <p className="text-xs text-muted">Saving a new customer needs an internet connection.</p>
          <div className="flex justify-end gap-2"><Button onClick={() => setCreating(false)}>Back</Button><Button type="submit" variant="primary" loading={busy}>Save and select</Button></div>
        </form>
      ) : (
        <div className="space-y-3">
          <Input autoFocus placeholder="Search by name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search customers" />
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {matches.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">{(customers ?? []).length === 0 ? "No saved customers yet." : "No customer matches."}</li>}
            {matches.map((c) => (
              <li key={c.id}>
                <button onClick={() => pick(c)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-surface-2">
                  <span><span className="font-medium">{c.name}</span>{c.phone && <span className="num ml-2 text-muted">{c.phone}</span>}</span>
                  {c.balance > 0 && <span className="num text-xs text-warn">owes {formatINR(Math.round(c.balance * 100))}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-between gap-2">
            <Button onClick={() => { setV({ ...emptyCustomer, ...(/^[0-9+ -]{6,}$/.test(q.trim()) ? { phone: q.trim() } : { name: q.trim() }) }); setCreating(true); }}>New customer</Button>
            <div className="flex gap-2">
              {q.trim() && matches.length === 0 && <Button onClick={() => { cart.setCustomer({ id: null, name: q.trim(), phone: "", gstin: "", stateCode: null }); close(); }} title="Print this name on the bill without saving a customer">Use &ldquo;{q.trim().slice(0, 18)}&rdquo; once</Button>}
              {cart.customer && <Button variant="ghost" onClick={() => { cart.setCustomer(null); close(); }}>Walk-in (remove)</Button>}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
