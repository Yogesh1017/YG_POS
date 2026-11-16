"use client";
import { Pencil, Plus, Tags, Trash2, Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorNote, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { api, errorText, formatDate, today, useApi } from "@/lib/api";
import { formatINR, paiseToDecimal, parseRupees } from "@/lib/money";
import { METHOD_LABELS, type Method, type Named } from "@/lib/types";
import { NamedListDialog } from "@/components/products-screen";

interface Expense { id: number; category_id: number | null; category_name: string | null; amount: number; method: Method; spent_on: string; note: string | null; user_name: string | null }

export default function ExpensesPage() {
  return <ManagersOnly><Expenses /></ManagersOnly>;
}

function Expenses() {
  const [range, setRange] = useState({ from: `${today().slice(0, 8)}01`, to: today() });
  const list = useApi<Expense[]>("expenses.list", range);
  const cats = useApi<Named[]>("expense_categories.list");
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [managing, setManaging] = useState(false);
  const total = (list.data ?? []).reduce((a, e) => a + e.amount, 0);
  return (
    <Page>
      <PageHeader title="Expenses" description="Rent, electricity, salaries, transport and other running costs. They are deducted from gross profit to give net profit." actions={
        <><Button onClick={() => setManaging(true)}><Tags className="size-4" /> Categories</Button><Button variant="primary" onClick={() => setEditing("new")}><Plus className="size-4" /> Add expense</Button></>
      } />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From">{(p) => <Input {...p} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />}</Field>
        <p className="pb-2 text-sm text-muted">Total: <b className="num text-text">{formatINR(total)}</b></p>
      </div>
      <Card className="overflow-hidden">
        {list.error ? <div className="p-4"><ErrorNote onRetry={list.reload}>{list.error}</ErrorNote></div> : !list.data ? <Spinner /> : list.data.length === 0 ? <EmptyState icon={<Wallet />} title="No expenses in this period" /> : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Date</th><th className={th}>Category</th><th className={th}>Note</th><th className={th}>Paid by</th><th className={`${th} text-right`}>Amount</th><th className={th} /></tr></thead>
            <tbody className="divide-y divide-border">{list.data.map((e) => (
              <tr key={e.id}><td className={`${td} whitespace-nowrap text-muted`}>{formatDate(e.spent_on)}</td><td className={td}>{e.category_name ?? <span className="text-muted">—</span>}</td><td className={`${td} text-muted`}>{e.note}</td><td className={td}>{METHOD_LABELS[e.method]}</td>
                <td className={`${td} num text-right font-medium`}>{formatINR(e.amount)}</td>
                <td className={`${td} whitespace-nowrap text-right`}><Button size="sm" variant="ghost" aria-label="Edit expense" onClick={() => setEditing(e)}><Pencil className="size-4" /></Button><Button size="sm" variant="ghost" aria-label="Delete expense" onClick={() => setDeleting(e)}><Trash2 className="size-4" /></Button></td></tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      {editing && <ExpenseDialog expense={editing === "new" ? null : editing} categories={cats.data ?? []} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
      {managing && <NamedListDialog kind="expense_categories" items={cats.data ?? []} onClose={() => setManaging(false)} onChanged={() => { void cats.reload(); void list.reload(); }} />}
      <ConfirmDialog open={!!deleting} danger title="Delete expense?" confirmLabel="Delete" onClose={() => setDeleting(null)} message={<>Delete the expense of <b className="num">{deleting && formatINR(deleting.amount)}</b>? The deletion is recorded in the audit log.</>}
        onConfirm={async () => { try { await api("expenses.delete", { id: deleting!.id }); setDeleting(null); void list.reload(); } catch (e) { toast.error(errorText(e)); } }} />
    </Page>
  );
}

function ExpenseDialog({ expense, categories, onClose, onSaved }: { expense: Expense | null; categories: Named[]; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ category_id: expense?.category_id ? String(expense.category_id) : "", amount: expense ? paiseToDecimal(expense.amount) : "", method: expense?.method ?? ("cash" as Method), spent_on: expense?.spent_on ?? today(), note: expense?.note ?? "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const amount = parseRupees(v.amount);
    if (amount === null || amount <= 0) return setError("Enter the amount.");
    setBusy(true);
    try { await api("expenses.save", { id: expense?.id ?? null, category_id: v.category_id ? Number(v.category_id) : null, amount, method: v.method, spent_on: v.spent_on, note: v.note }); onSaved(); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={expense ? "Edit expense" : "Add expense"}>
      <form onSubmit={submit} noValidate className="grid grid-cols-2 gap-4">
        <Field label="Amount (₹)">{(p) => <Input {...p} className="num" inputMode="decimal" autoFocus value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />}</Field>
        <Field label="Date">{(p) => <Input {...p} type="date" max={today()} value={v.spent_on} onChange={(e) => setV({ ...v, spent_on: e.target.value })} />}</Field>
        <Field label="Category">{(p) => <Select {...p} value={v.category_id} onChange={(e) => setV({ ...v, category_id: e.target.value })}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
        <Field label="Paid by">{(p) => <Select {...p} value={v.method} onChange={(e) => setV({ ...v, method: e.target.value as Method })}>{Object.entries(METHOD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>}</Field>
        <Field label="Note" className="col-span-2">{(p) => <Input {...p} maxLength={200} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />}</Field>
        {error && <p role="alert" className="col-span-2 text-sm text-danger">{error}</p>}
        <div className="col-span-2 flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}
