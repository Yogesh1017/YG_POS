"use client";
import { BookOpen, HandCoins, Pencil, Plus, Tag, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Page } from "@/components/app-shell";
import { LedgerDialog, PartyDialog, PaymentDialog } from "@/components/party";
import { ProductCombo, productLabel } from "@/components/pickers";
import { Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { formatINR, paiseToDecimal, parseRupees } from "@/lib/money";
import { useShop } from "@/lib/session";
import type { Customer, Product } from "@/lib/types";

export default function CustomersPage() {
  const { canManage } = useShop();
  const customers = useApi<Customer[]>("customers.list");
  const [q, setQ] = useState("");
  const [onlyDues, setOnlyDues] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [dialog, setDialog] = useState<{ type: "edit" | "pay" | "ledger" | "prices" | "delete"; customer: Customer | null } | null>(null);
  const close = () => setDialog(null);
  const done = () => { close(); void customers.reload(); };

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (customers.data ?? []).filter((c) => (showInactive || c.is_active) && (!onlyDues || c.balance > 0) && (!s || [c.name, c.contact_person, c.phone, c.city].filter(Boolean).join(" ").toLowerCase().includes(s)));
  }, [customers.data, q, onlyDues, showInactive]);
  if (!customers.data) return <Spinner />;
  const totalDue = customers.data.reduce((a, c) => a + c.balance, 0);

  return (
    <Page>
      <PageHeader title="Customers" description={totalDue > 0 ? `Total outstanding: ${formatINR(totalDue)}` : "Shops and businesses you sell to"} actions={<Button variant="primary" onClick={() => setDialog({ type: "edit", customer: null })}><Plus className="size-4" /> Add customer</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Input className="max-w-xs" placeholder="Search name, contact, phone, city" aria-label="Search customers" value={q} onChange={(e) => setQ(e.target.value)} />
        <Checkbox label="Only with balance due" checked={onlyDues} onChange={(e) => setOnlyDues(e.target.checked)} />
        <Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      </div>
      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState icon={<Users />} title={customers.data.length === 0 ? "No customers yet" : "No customers match"}>{customers.data.length === 0 ? "Add the shops you supply. Credit sales, special prices and ledgers are kept per customer." : undefined}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Customer</th><th className={th}>Contact</th><th className={`${th} text-right`}>Credit limit</th><th className={`${th} text-right`}>Balance due</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((c) => (
                  <tr key={c.id} className={c.is_active ? "" : "opacity-60"}>
                    <td className={td}><div className="font-medium">{c.name} {!c.is_active && <Badge>Inactive</Badge>}</div><div className="num text-xs text-muted">{[c.city, c.gstin && `GSTIN ${c.gstin}`].filter(Boolean).join(" · ")}</div></td>
                    <td className={`${td} text-muted`}>{c.contact_person}<div className="num text-xs">{c.phone}</div></td>
                    <td className={`${td} num text-right text-muted`}>{c.credit_limit !== null ? formatINR(c.credit_limit) : "—"}</td>
                    <td className={`${td} num text-right font-medium`}>{c.balance > 0 ? <span className={c.credit_limit !== null && c.balance > c.credit_limit ? "text-danger" : "text-warn"}>{formatINR(c.balance)}</span> : <span className="text-muted">—</span>}</td>
                    <td className={`${td} whitespace-nowrap text-right`}>
                      {c.balance > 0 && <Button size="sm" onClick={() => setDialog({ type: "pay", customer: c })}><HandCoins className="size-4" /> Receive</Button>}{" "}
                      <Button size="sm" variant="ghost" title="Ledger" aria-label={`Ledger of ${c.name}`} onClick={() => setDialog({ type: "ledger", customer: c })}><BookOpen className="size-4" /></Button>
                      {canManage && <Button size="sm" variant="ghost" title="Special prices" aria-label={`Special prices for ${c.name}`} onClick={() => setDialog({ type: "prices", customer: c })}><Tag className="size-4" /></Button>}
                      <Button size="sm" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setDialog({ type: "edit", customer: c })}><Pencil className="size-4" /></Button>
                      {canManage && <Button size="sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => setDialog({ type: "delete", customer: c })}><Trash2 className="size-4" /></Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {dialog?.type === "edit" && <PartyDialog kind="customers" party={dialog.customer} onClose={close} onSaved={done} />}
      {dialog?.type === "pay" && <PaymentDialog kind="customers" party={dialog.customer!} onClose={close} onSaved={done} />}
      {dialog?.type === "ledger" && <LedgerDialog kind="customers" party={dialog.customer!} onClose={close} />}
      {dialog?.type === "prices" && <PricesDialog customer={dialog.customer!} onClose={close} />}
      <ConfirmDialog open={dialog?.type === "delete"} danger title="Delete customer?" confirmLabel="Delete" onClose={close} message={<>Delete <b>{dialog?.customer?.name}</b>? Customers with invoices or payments cannot be deleted — mark them inactive instead.</>}
        onConfirm={async () => { try { await api("customers.delete", { id: dialog!.customer!.id }); toast.success("Customer deleted"); done(); } catch (e) { toast.error(errorText(e)); } }} />
    </Page>
  );
}

/** Rates agreed with one customer. They apply automatically when billing that customer. */
function PricesDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const products = useApi<Product[]>("products.list");
  const prices = useApi<{ unit_id: number; price: number; unit_name: string; list_price: number; product_id: number; product_name: string }[]>("customers.prices", { customer_id: customer.id });
  const [picked, setPicked] = useState<Product | null>(null);
  const [unitId, setUnitId] = useState(0);
  const [price, setPrice] = useState("");
  const save = async (unit: number, value: number | null) => {
    try { await api("customers.setPrice", { customer_id: customer.id, unit_id: unit, price: value }); setPicked(null); setPrice(""); await prices.reload(); }
    catch (e) { toast.error(errorText(e)); }
  };
  if (!products.data || !prices.data) return <Dialog open onClose={onClose} title="Special prices"><Spinner /></Dialog>;
  const unit = picked?.units.find((u) => u.id === unitId);
  return (
    <Dialog open onClose={onClose} wide title={`Special prices — ${customer.name}`}>
      <div className="mb-4 space-y-2">
        <ProductCombo products={products.data} autoFocus onPick={(p) => { setPicked(p); const u = p.units.find((x) => x.is_default_sale && x.is_active) ?? p.units[0]; setUnitId(u.id); setPrice(""); }} />
        {picked && (
          <form className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-2 p-3 text-sm" onSubmit={(e) => { e.preventDefault(); const p = parseRupees(price); if (p === null) return void toast.error("Enter a valid rate"); void save(unitId, p); }}>
            <span className="pb-2 font-medium">{productLabel(picked)}</span>
            <Select aria-label="Unit" className="w-32" value={unitId} onChange={(e) => setUnitId(Number(e.target.value))}>{picked.units.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select>
            <Input aria-label="Special rate" className="num w-32" inputMode="decimal" autoFocus placeholder={unit ? `List ${paiseToDecimal(unit.sale_price)}` : ""} value={price} onChange={(e) => setPrice(e.target.value)} />
            <Button type="submit" variant="primary">Set rate</Button>
          </form>
        )}
      </div>
      {prices.data.length === 0 ? <p className="py-6 text-center text-sm text-muted">No special prices. This customer is billed at list and quantity prices.</p> : (
        <table className="w-full text-sm">
          <thead><tr><th className={th}>Product</th><th className={th}>Unit</th><th className={`${th} text-right`}>List rate</th><th className={`${th} text-right`}>Their rate</th><th className={th} /></tr></thead>
          <tbody className="divide-y divide-border">{prices.data.map((p) => (
            <tr key={p.unit_id}><td className={td}>{p.product_name}</td><td className={td}>{p.unit_name}</td><td className={`${td} num text-right text-muted`}>{formatINR(p.list_price)}</td><td className={`${td} num text-right font-medium`}>{formatINR(p.price)}</td>
              <td className={`${td} text-right`}><Button size="sm" variant="ghost" aria-label={`Remove special price for ${p.product_name} ${p.unit_name}`} onClick={() => void save(p.unit_id, null)}><Trash2 className="size-4" /></Button></td></tr>
          ))}</tbody>
        </table>
      )}
    </Dialog>
  );
}
