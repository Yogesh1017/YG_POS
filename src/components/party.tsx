"use client";
// Shared pieces for customers and suppliers: the edit form, recording a payment, and the ledger.
import { Printer } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { StatementA4 } from "@/components/documents";
import { usePrinter } from "@/components/sale-actions";
import { Button, Checkbox, Dialog, ErrorNote, Field, Input, Select, Spinner, td, th } from "@/components/ui";
import { api, errorText, formatDate, newRef, today, useApi } from "@/lib/api";
import { GST_STATES } from "@/lib/gst";
import { formatINR, formatPaise, paiseToDecimal, parseRupees } from "@/lib/money";
import { useShop } from "@/lib/session";
import { METHOD_LABELS, type Customer, type Ledger, type Method, type Supplier } from "@/lib/types";

type Kind = "customers" | "suppliers";
type Party = Customer | Supplier;

export function PartyDialog({ kind, party, onClose, onSaved }: { kind: Kind; party: Party | null; onClose: () => void; onSaved: () => void }) {
  const { gst, canManage } = useShop();
  const c = party as Customer | null;
  const [v, setV] = useState({
    name: party?.name ?? "", contact_person: party?.contact_person ?? "", phone: party?.phone ?? "", gstin: party?.gstin ?? "", state_code: party?.state_code ?? "",
    address: party?.address ?? "", city: c?.city ?? "", notes: party?.notes ?? "", is_active: party ? !!party.is_active : true,
    opening: party ? paiseToDecimal(party.opening_balance) : "", credit_limit: c?.credit_limit != null ? paiseToDecimal(c.credit_limit) : "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((s) => ({ ...s, [k]: value }));
  const isCustomer = kind === "customers";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const opening = v.opening.trim() === "" ? 0 : parseRupees(v.opening);
    const limit = v.credit_limit.trim() === "" ? null : parseRupees(v.credit_limit);
    if (opening === null) return setError("Enter a valid opening balance.");
    if (v.credit_limit.trim() !== "" && limit === null) return setError("Enter a valid credit limit.");
    setError("");
    setBusy(true);
    try {
      await api(`${kind}.save`, {
        id: party?.id ?? null, name: v.name, contact_person: v.contact_person, phone: v.phone, gstin: v.gstin, state_code: v.state_code || null, address: v.address, notes: v.notes,
        is_active: v.is_active, opening_balance: opening, ...(isCustomer ? { city: v.city, credit_limit: limit } : {}),
      });
      toast.success("Saved");
      onSaved();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} wide title={`${party ? "Edit" : "Add"} ${isCustomer ? "customer" : "supplier"}`}>
      <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-6">
        <Field label={isCustomer ? "Shop / business name" : "Supplier name"} className="sm:col-span-3">{(p) => <Input {...p} autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label="Contact person" className="sm:col-span-3">{(p) => <Input {...p} value={v.contact_person} onChange={(e) => set("contact_person", e.target.value)} />}</Field>
        <Field label="Phone" className="sm:col-span-2">{(p) => <Input {...p} inputMode="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} />}</Field>
        {gst && <Field label="GSTIN" className="sm:col-span-2">{(p) => <Input {...p} className="num uppercase" maxLength={15} value={v.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase())} />}</Field>}
        {gst && <Field label="State" hint={isCustomer ? "Another state = IGST on their invoices." : undefined} className="sm:col-span-2">{(p) => (
          <Select {...p} value={v.state_code} onChange={(e) => set("state_code", e.target.value)}><option value="">Same as ours</option>{GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select>
        )}</Field>}
        <Field label="Address" className={isCustomer ? "sm:col-span-4" : "sm:col-span-6"}>{(p) => <Input {...p} value={v.address} onChange={(e) => set("address", e.target.value)} />}</Field>
        {isCustomer && <Field label="City / area" className="sm:col-span-2">{(p) => <Input {...p} value={v.city} onChange={(e) => set("city", e.target.value)} />}</Field>}
        {canManage && <>
          <Field label={isCustomer ? "Opening balance they owe (₹)" : "Opening balance we owe (₹)"} hint="Amount outstanding before you started using this app." className="sm:col-span-3">{(p) => <Input {...p} className="num" inputMode="decimal" placeholder="0.00" value={v.opening} onChange={(e) => set("opening", e.target.value)} />}</Field>
          {isCustomer && <Field label="Credit limit (₹)" hint="Leave empty for no limit. Going over needs owner/manager approval." className="sm:col-span-3">{(p) => <Input {...p} className="num" inputMode="decimal" value={v.credit_limit} onChange={(e) => set("credit_limit", e.target.value)} />}</Field>}
        </>}
        <Field label="Notes" className="sm:col-span-6">{(p) => <Input {...p} value={v.notes} onChange={(e) => set("notes", e.target.value)} />}</Field>
        {canManage && party && <div className="sm:col-span-6"><Checkbox label="Active" hint="Inactive records are hidden when billing." checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} /></div>}
        {error && <p role="alert" className="text-sm text-danger sm:col-span-6">{error}</p>}
        <div className="flex justify-end gap-2 sm:col-span-6"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}

/** Record money received from a customer, or paid to a supplier. Nothing is charged or transferred by the app. */
export function PaymentDialog({ kind, party, onClose, onSaved }: { kind: Kind; party: Party; onClose: () => void; onSaved: () => void }) {
  const isCustomer = kind === "customers";
  const [amount, setAmount] = useState(paiseToDecimal(party.balance));
  const [method, setMethod] = useState<Method>("cash");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(today());
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ref] = useState(newRef); // pressing Save twice records the money once

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const paise = parseRupees(amount);
    if (paise === null || paise <= 0) return setError("Enter the amount.");
    setError("");
    setBusy(true);
    try {
      await api(isCustomer ? "customers.collect" : "suppliers.pay", { client_ref: ref, [isCustomer ? "customer_id" : "supplier_id"]: party.id, amount: paise, method, reference, note, paid_on: paidOn });
      toast.success(isCustomer ? `Received ${formatINR(paise)} from ${party.name}` : `Paid ${formatINR(paise)} to ${party.name}`);
      onSaved();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={isCustomer ? `Payment received — ${party.name}` : `Payment made — ${party.name}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted">{isCustomer ? "They owe" : "We owe"} <b className="num text-text">{formatINR(party.balance)}</b>. The payment settles the oldest dues first. This only records the payment.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount (₹)">{(p) => <Input {...p} className="num" inputMode="decimal" autoFocus onFocus={(e) => e.target.select()} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Paid by">{(p) => <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as Method)}>{Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
          <Field label="Date">{(p) => <Input {...p} type="date" max={today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
          <Field label="Reference / cheque no">{(p) => <Input {...p} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
        </div>
        <Field label="Note">{(p) => <Input {...p} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Record payment</Button></div>
      </form>
    </Dialog>
  );
}

export function LedgerDialog({ kind, party, onClose }: { kind: Kind; party: Party; onClose: () => void }) {
  const { settings } = useShop();
  const isCustomer = kind === "customers";
  const [range, setRange] = useState({ from: "", to: "" });
  const q = useApi<Ledger>(`${kind}.ledger`, { [isCustomer ? "customer_id" : "supplier_id"]: party.id, from: range.from || null, to: range.to || null });
  const printer = usePrinter();
  return (
    <Dialog open onClose={onClose} wide title={`Ledger — ${party.name}`} footer={q.data && (
      <Button variant="primary" onClick={() => printer.start({ paper: "a4", mode: "print", content: <StatementA4 title={isCustomer ? "Statement of account" : "Supplier statement"} party={party} ledger={q.data!} settings={settings} from={range.from || undefined} to={range.to || undefined} /> })}><Printer className="size-4" /> Print statement</Button>
    )}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="From">{(p) => <Input {...p} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
        <p className="pb-2 text-sm text-muted">{isCustomer ? "Owes now" : "We owe now"}: <b className="num text-text">{formatINR(party.balance)}</b></p>
      </div>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !q.data ? <Spinner /> : (
        <table className="w-full text-sm">
          <thead><tr><th className={th}>Date</th><th className={th}>Particulars</th><th className={`${th} text-right`}>{isCustomer ? "Billed" : "Purchased"}</th><th className={`${th} text-right`}>{isCustomer ? "Received" : "Paid"}</th><th className={`${th} text-right`}>Balance</th></tr></thead>
          <tbody className="divide-y divide-border">
            {q.data.opening !== 0 && <tr><td className={td} /><td className={`${td} text-muted`}>Balance brought forward</td><td className={td} /><td className={td} /><td className={`${td} num text-right`}>{formatPaise(q.data.opening)}</td></tr>}
            {q.data.entries.map((e, i) => (
              <tr key={i}><td className={`${td} whitespace-nowrap text-muted`}>{formatDate(e.date)}</td><td className={td}>{e.type}{e.ref && <span className="num text-muted"> — {e.ref}</span>}</td>
                <td className={`${td} num text-right`}>{e.debit ? formatPaise(e.debit) : ""}</td><td className={`${td} num text-right`}>{e.credit ? formatPaise(e.credit) : ""}</td><td className={`${td} num text-right font-medium`}>{formatPaise(e.balance)}</td></tr>
            ))}
            {q.data.entries.length === 0 && <tr><td colSpan={5} className="py-8 text-center text-muted">No transactions in this period.</td></tr>}
            <tr className="font-semibold"><td className={td} /><td className={td}>Closing balance</td><td className={td} /><td className={td} /><td className={`${td} num text-right`}>{formatINR(q.data.closing)}</td></tr>
          </tbody>
        </table>
      )}
      {printer.element}
    </Dialog>
  );
}
