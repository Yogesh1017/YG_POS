"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { HandCoins, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Page } from "@/components/app-shell";
import { CustomerFields, emptyCustomer, saveCustomer } from "@/components/customer-picker";
import { Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { db } from "@/lib/db";
import { PAYMENT_LABELS, formatDateTime } from "@/lib/invoice";
import { formatINR, paiseToDecimal, parseRupees, rupeesToPaise } from "@/lib/money";
import { customerSchema, fieldErrors, type CustomerForm } from "@/lib/schemas";
import { useShop } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Customer, PaymentMethod } from "@/lib/types";
import { unwrap, useQuery } from "@/lib/use-query";

export default function CustomersPage() {
  const { business, canManage } = useShop();
  const customers = useLiveQuery(() => db.customers.where("business_id").equals(business.id).toArray(), [business.id]);
  const [q, setQ] = useState("");
  const [onlyDues, setOnlyDues] = useState(false);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [collecting, setCollecting] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (customers ?? []).filter((c) => (!onlyDues || c.balance > 0) && (!s || c.name.toLowerCase().includes(s) || c.phone?.includes(s))).sort((a, b) => a.name.localeCompare(b.name));
  }, [customers, q, onlyDues]);
  const totalDue = (customers ?? []).reduce((a, c) => a + rupeesToPaise(c.balance), 0);

  if (!customers) return <Spinner />;
  return (
    <Page>
      <PageHeader title="Customers" description={totalDue > 0 ? `Total dues to collect: ${formatINR(totalDue)}` : "Saved customers and what they owe"}
        actions={<Button variant="primary" onClick={() => setEditing("new")}><Plus className="size-4" /> Add customer</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search name or phone" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
        <Checkbox label="Only customers with dues" checked={onlyDues} onChange={(e) => setOnlyDues(e.target.checked)} />
      </div>
      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState icon={<Users />} title={customers.length === 0 ? "No customers yet" : "No customers match"}>{customers.length === 0 ? "Save a customer to sell on credit or to print their name and GSTIN on bills." : undefined}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Customer</th><th className={th}>Phone</th><th className={`${th} text-right`}>Owes</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td className={td}><button className="text-left font-medium hover:underline" onClick={() => setViewing(c)}>{c.name}</button>{c.gstin && <div className="num text-xs text-muted">GSTIN {c.gstin}</div>}</td>
                    <td className={`${td} num text-muted`}>{c.phone}</td>
                    <td className={`${td} num text-right font-medium`}>{c.balance > 0 ? <span className="text-warn">{formatINR(rupeesToPaise(c.balance))}</span> : <span className="text-muted">—</span>}</td>
                    <td className={`${td} whitespace-nowrap text-right`}>
                      {c.balance > 0 && <Button size="sm" onClick={() => setCollecting(c)}><HandCoins className="size-4" /> Collect</Button>}{" "}
                      <Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}><Pencil className="size-4" /></Button>
                      {canManage && <Button size="sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}><Trash2 className="size-4" /></Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <CustomerDialog customer={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {viewing && <CustomerHistory customer={viewing} onClose={() => setViewing(null)} />}
      {collecting && <CollectDialog customer={collecting} onClose={() => setCollecting(null)} />}
      <ConfirmDialog open={!!deleting} danger title="Delete customer?" confirmLabel="Delete" onClose={() => setDeleting(null)} message={<>Delete <b>{deleting?.name}</b>? Customers with bills cannot be deleted.</>}
        onConfirm={async () => {
          const { error } = await supabase().from("customers").delete().eq("id", deleting!.id);
          if (error) { toast.error(error.code === "23503" ? "This customer has bills or payments on record, so they cannot be deleted." : errorMessage(error)); return; }
          await db.customers.delete(deleting!.id);
          toast.success("Customer deleted");
          setDeleting(null);
        }} />
    </Page>
  );
}

function CustomerDialog({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  const { business } = useShop();
  const [v, setV] = useState<CustomerForm>(customer ? { name: customer.name, phone: customer.phone ?? "", gstin: customer.gstin ?? "", state_code: customer.state_code ?? "", address: customer.address ?? "" } : emptyCustomer);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = customerSchema.safeParse(v);
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    const saved = await saveCustomer(business.id, parsed.data, customer?.id);
    setBusy(false);
    if (saved) { toast.success("Customer saved"); onClose(); }
  };
  return (
    <Dialog open onClose={onClose} title={customer ? "Edit customer" : "Add customer"}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <CustomerFields v={v} set={(k, value) => setV((s) => ({ ...s, [k]: value }))} errors={errors} showGst={business.gst_registered} />
        <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}

function CollectDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const owed = rupeesToPaise(customer.balance);
  const [amount, setAmount] = useState(paiseToDecimal(owed));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [reference, setReference] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One id per dialog, so pressing Save twice or retrying after a dropped connection cannot record the money twice.
  const [paymentId] = useState(() => crypto.randomUUID());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const paise = parseRupees(amount);
    if (paise === null || paise <= 0) return setError("Enter the amount received.");
    if (paise > owed) return setError(`${customer.name} owes only ${formatINR(owed)}.`);
    setError("");
    setBusy(true);
    const { data, error: err } = await supabase().rpc("record_customer_payment", { p_id: paymentId, p_customer_id: customer.id, p_amount: paise / 100, p_method: method, p_reference: reference });
    setBusy(false);
    if (err) return setError(errorMessage(err));
    await db.customers.update(customer.id, { balance: Number(data.balance) });
    toast.success(`Received ${formatINR(paise)} from ${customer.name}`);
    onClose();
  };
  return (
    <Dialog open onClose={onClose} title={`Collect dues — ${customer.name}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <p className="text-sm text-muted">Owes <b className="num text-text">{formatINR(owed)}</b>. The payment is applied to the oldest unpaid bills first.</p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount received (₹)">{(p) => <Input {...p} className="num" inputMode="decimal" autoFocus onFocus={(e) => e.target.select()} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Paid by">{(p) => <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>{Object.entries(PAYMENT_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        </div>
        {method !== "cash" && <Field label="Reference / UTR (optional)">{(p) => <Input {...p} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Record payment</Button></div>
      </form>
    </Dialog>
  );
}

function CustomerHistory({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const q = useQuery(async () => {
    const [sales, payments] = await Promise.all([
      supabase().from("sales").select("id, invoice_no, sold_at, status, grand_total, due_amount").eq("customer_id", customer.id).order("sold_at", { ascending: false }).limit(50),
      supabase().from("payments").select("id, kind, method, amount, paid_at").eq("customer_id", customer.id).eq("kind", "due_collection").order("paid_at", { ascending: false }).limit(50),
    ]);
    return { sales: unwrap(sales) as any[], payments: unwrap(payments) as any[] };
  }, [customer.id]);
  return (
    <Dialog open onClose={onClose} wide title={customer.name}>
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
        {customer.phone && <span className="num">{customer.phone}</span>}{customer.gstin && <span className="num">GSTIN {customer.gstin}</span>}{customer.address && <span>{customer.address}</span>}
        <span>Owes <b className={customer.balance > 0 ? "num text-warn" : "num text-text"}>{formatINR(rupeesToPaise(customer.balance))}</b></span>
      </div>
      {q.error ? <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote> : !q.data ? <Spinner /> : (
        <div className="space-y-5">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Bills</h3>
            {q.data.sales.length === 0 ? <p className="text-sm text-muted">No bills yet.</p> : (
              <table className="w-full text-sm"><tbody className="divide-y divide-border">
                {q.data.sales.map((s) => (
                  <tr key={s.id}><td className={`${td} num`}>{s.invoice_no}</td><td className={`${td} text-muted`}>{formatDateTime(s.sold_at)}</td>
                    <td className={`${td} num text-right`}>{formatINR(rupeesToPaise(s.grand_total))}</td>
                    <td className={`${td} text-right`}>{s.status === "cancelled" ? <Badge tone="danger">Cancelled</Badge> : s.due_amount > 0 ? <Badge tone="warn">Due {formatINR(rupeesToPaise(s.due_amount))}</Badge> : <Badge tone="success">Paid</Badge>}</td></tr>
                ))}
              </tbody></table>
            )}
          </div>
          {q.data.payments.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Dues collected</h3>
              <table className="w-full text-sm"><tbody className="divide-y divide-border">
                {q.data.payments.map((p) => <tr key={p.id}><td className={`${td} text-muted`}>{formatDateTime(p.paid_at)}</td><td className={td}>{PAYMENT_LABELS[p.method as PaymentMethod]}</td><td className={`${td} num text-right`}>{formatINR(rupeesToPaise(p.amount))}</td></tr>)}
              </tbody></table>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
