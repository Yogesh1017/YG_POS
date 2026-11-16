"use client";
import { BookOpen, Factory, HandCoins, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { LedgerDialog, PartyDialog, PaymentDialog } from "@/components/party";
import { Badge, Button, Card, ConfirmDialog, EmptyState, Input, PageHeader, Spinner, td, th } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { formatINR } from "@/lib/money";
import type { Supplier } from "@/lib/types";

export default function SuppliersPage() {
  return <ManagersOnly><Suppliers /></ManagersOnly>;
}

function Suppliers() {
  const suppliers = useApi<Supplier[]>("suppliers.list");
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<{ type: "edit" | "pay" | "ledger" | "delete"; supplier: Supplier | null } | null>(null);
  const close = () => setDialog(null);
  const done = () => { close(); void suppliers.reload(); };
  const rows = useMemo(() => (suppliers.data ?? []).filter((s) => !q.trim() || [s.name, s.contact_person, s.phone].filter(Boolean).join(" ").toLowerCase().includes(q.trim().toLowerCase())), [suppliers.data, q]);
  if (!suppliers.data) return <Spinner />;
  const total = suppliers.data.reduce((a, s) => a + s.balance, 0);
  return (
    <Page>
      <PageHeader title="Suppliers" description={total > 0 ? `Total we owe: ${formatINR(total)}` : "Companies and distributors you buy from"} actions={<Button variant="primary" onClick={() => setDialog({ type: "edit", supplier: null })}><Plus className="size-4" /> Add supplier</Button>} />
      <Input className="mb-4 max-w-xs" placeholder="Search suppliers" aria-label="Search suppliers" value={q} onChange={(e) => setQ(e.target.value)} />
      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState icon={<Factory />} title={suppliers.data.length === 0 ? "No suppliers yet" : "No suppliers match"}>{suppliers.data.length === 0 ? "Add a supplier, then enter their bills under Purchases." : undefined}</EmptyState> : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Supplier</th><th className={th}>Contact</th><th className={`${th} text-right`}>We owe</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-border">
              {rows.map((s) => (
                <tr key={s.id} className={s.is_active ? "" : "opacity-60"}>
                  <td className={td}><div className="font-medium">{s.name} {!s.is_active && <Badge>Inactive</Badge>}</div>{s.gstin && <div className="num text-xs text-muted">GSTIN {s.gstin}</div>}</td>
                  <td className={`${td} text-muted`}>{s.contact_person}<div className="num text-xs">{s.phone}</div></td>
                  <td className={`${td} num text-right font-medium`}>{s.balance > 0 ? <span className="text-warn">{formatINR(s.balance)}</span> : <span className="text-muted">—</span>}</td>
                  <td className={`${td} whitespace-nowrap text-right`}>
                    {s.balance > 0 && <Button size="sm" onClick={() => setDialog({ type: "pay", supplier: s })}><HandCoins className="size-4" /> Pay</Button>}{" "}
                    <Button size="sm" variant="ghost" title="Ledger" aria-label={`Ledger of ${s.name}`} onClick={() => setDialog({ type: "ledger", supplier: s })}><BookOpen className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label={`Edit ${s.name}`} onClick={() => setDialog({ type: "edit", supplier: s })}><Pencil className="size-4" /></Button>
                    <Button size="sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => setDialog({ type: "delete", supplier: s })}><Trash2 className="size-4" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {dialog?.type === "edit" && <PartyDialog kind="suppliers" party={dialog.supplier} onClose={close} onSaved={done} />}
      {dialog?.type === "pay" && <PaymentDialog kind="suppliers" party={dialog.supplier!} onClose={close} onSaved={done} />}
      {dialog?.type === "ledger" && <LedgerDialog kind="suppliers" party={dialog.supplier!} onClose={close} />}
      <ConfirmDialog open={dialog?.type === "delete"} danger title="Delete supplier?" confirmLabel="Delete" onClose={close} message={<>Delete <b>{dialog?.supplier?.name}</b>? Suppliers with purchases or payments cannot be deleted.</>}
        onConfirm={async () => { try { await api("suppliers.delete", { id: dialog!.supplier!.id }); toast.success("Supplier deleted"); done(); } catch (e) { toast.error(errorText(e)); } }} />
    </Page>
  );
}
