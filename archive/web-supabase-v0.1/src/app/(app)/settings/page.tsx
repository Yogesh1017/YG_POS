"use client";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Page } from "@/components/app-shell";
import { BusinessForm, businessDefaults } from "@/components/business-form";
import { usePaper, type Paper } from "@/components/receipt";
import { Badge, Button, Card, ErrorNote, Field, Input, PageHeader, Select, Spinner, cn, td, th } from "@/components/ui";
import { emptyToNull } from "@/lib/schemas";
import { useSession, useShop } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Member, Role } from "@/lib/types";
import { unwrap, useQuery } from "@/lib/use-query";

type Tab = "shop" | "staff" | "device" | "account";

export default function SettingsPage() {
  const { isOwner } = useShop();
  const [tab, setTab] = useState<Tab>(isOwner ? "shop" : "device");
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "shop", label: "Shop & tax", show: true }, { id: "staff", label: "Staff", show: isOwner },
    { id: "device", label: "This device", show: true }, { id: "account", label: "My account", show: true },
  ];
  return (
    <Page className="max-w-3xl">
      <PageHeader title="Settings" />
      <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.filter((t) => t.show).map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap", tab === t.id ? "border-primary text-primary" : "border-transparent text-muted hover:text-text")}>{t.label}</button>
        ))}
      </div>
      {tab === "shop" && <ShopTab />}
      {tab === "staff" && isOwner && <StaffTab />}
      {tab === "device" && <DeviceTab />}
      {tab === "account" && <AccountTab />}
    </Page>
  );
}

function ShopTab() {
  const { business, isOwner, refresh } = useShop();
  if (!isOwner) {
    return (
      <Card className="space-y-1 p-5 text-sm">
        <p className="font-medium">{business.name}</p>
        <p className="text-muted">{[business.address, business.city, business.pincode].filter(Boolean).join(", ")}</p>
        {business.gst_registered && <p className="num text-muted">GSTIN {business.gstin}</p>}
        <p className="pt-2 text-muted">Only the owner can change shop and tax settings.</p>
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <BusinessForm mode="edit" initial={businessDefaults(business)} submitLabel="Save settings" onSubmit={async (v) => {
        const { error } = await supabase().from("businesses").update({
          name: v.name, legal_name: emptyToNull(v.legal_name), phone: emptyToNull(v.phone), email: emptyToNull(v.email), address: emptyToNull(v.address),
          city: emptyToNull(v.city), pincode: emptyToNull(v.pincode), state_code: emptyToNull(v.state_code), gst_registered: v.gst_registered,
          gstin: v.gst_registered ? v.gstin : emptyToNull(v.gstin), default_tax_rate: v.default_tax_rate, prices_include_tax: v.prices_include_tax,
          round_off_total: v.round_off_total, invoice_prefix: v.invoice_prefix, receipt_footer: emptyToNull(v.receipt_footer),
        }).eq("id", business.id);
        if (error) { toast.error(errorMessage(error)); return; }
        await refresh();
        toast.success("Settings saved");
      }} />
    </Card>
  );
}

function StaffTab() {
  const { business, member: me } = useShop();
  const q = useQuery(async () => unwrap(await supabase().from("business_members").select("*").eq("business_id", business.id).order("created_at")) as Member[], [business.id]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("cashier");
  const [busy, setBusy] = useState(false);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !name.trim()) return void toast.error("Enter the staff member's name and email");
    setBusy(true);
    const { error } = await supabase().rpc("add_member", { p_business_id: business.id, p_email: email.trim(), p_role: role, p_display_name: name.trim() });
    setBusy(false);
    if (error) return void toast.error(errorMessage(error));
    toast.success(`${name.trim()} added as ${role}`);
    setEmail(""); setName("");
    await q.reload();
  };
  const update = async (m: Member, patch: { role?: Role; is_active?: boolean }) => {
    const { error } = await supabase().rpc("set_member", { p_business_id: business.id, p_user_id: m.user_id, p_role: patch.role ?? m.role, p_is_active: patch.is_active ?? m.is_active });
    if (error) return void toast.error(errorMessage(error));
    toast.success("Updated");
    await q.reload();
  };

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        {q.error ? <div className="p-4"><ErrorNote onRetry={q.reload}>{q.error}</ErrorNote></div> : !q.data ? <Spinner /> : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Name</th><th className={th}>Role</th><th className={th}><span className="sr-only">Actions</span></th></tr></thead>
            <tbody className="divide-y divide-border">
              {q.data.map((m) => (
                <tr key={m.user_id} className={m.is_active ? "" : "opacity-60"}>
                  <td className={td}><div className="font-medium">{m.display_name} {m.user_id === me.user_id && <Badge>You</Badge>} {!m.is_active && <Badge tone="danger">Access removed</Badge>}</div><div className="text-xs text-muted">{m.email}</div></td>
                  <td className={td}>{m.role === "owner" ? "Owner" : (
                    <Select aria-label={`Role of ${m.display_name}`} className="h-8 w-32" value={m.role} onChange={(e) => void update(m, { role: e.target.value as Role })}><option value="manager">Manager</option><option value="cashier">Cashier</option></Select>
                  )}</td>
                  <td className={`${td} text-right`}>{m.role !== "owner" && <Button size="sm" onClick={() => void update(m, { is_active: !m.is_active })}>{m.is_active ? "Remove access" : "Restore access"}</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="text-sm font-semibold">Add staff</h2>
        <p className="mt-1 mb-4 text-sm text-muted">Ask them to create an account on the sign-up page first, then add the same email here. <b>Cashiers</b> can bill, see sales and collect dues. <b>Managers</b> can also edit products and stock, cancel bills, take returns and see reports.</p>
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />}</Field>
          <Field label="Their account email">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Role">{(p) => <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}><option value="cashier">Cashier</option><option value="manager">Manager</option></Select>}</Field>
          <Button type="submit" variant="primary" loading={busy}>Add</Button>
        </form>
      </Card>
    </div>
  );
}

function DeviceTab() {
  const [paper, setPaper] = usePaper();
  return (
    <Card className="space-y-5 p-5">
      <Field label="Bill paper size" hint="Saved on this device only, since each counter has its own printer.">{(p) => (
        <Select {...p} className="max-w-xs" value={paper} onChange={(e) => { setPaper(e.target.value as Paper); toast.success("Paper size saved"); }}>
          <option value="80mm">80 mm thermal roll</option><option value="58mm">58 mm thermal roll</option><option value="a4">A4 sheet (desktop printer)</option>
        </Select>
      )}</Field>
      <div className="space-y-2 text-sm text-muted">
        <p className="font-medium text-text">Hardware notes</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li><b>Printers:</b> bills print through your browser&apos;s print dialog. Install the printer&apos;s driver, choose the matching paper size in the dialog once, and turn off headers/footers and margins.</li>
          <li><b>Barcode scanners:</b> USB/Bluetooth scanners that type like a keyboard work on the billing screen with no setup. Set the scanner to send Enter after each scan.</li>
          <li><b>Cash drawer:</b> a browser cannot open a drawer directly. Connect it to the receipt printer and enable “open drawer when printing” in the printer driver settings.</li>
        </ul>
      </div>
    </Card>
  );
}

function AccountTab() {
  const { email, signOut } = useSession();
  const { member } = useShop();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const change = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return void toast.error("Use at least 8 characters");
    setBusy(true);
    const { error } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (error) return void toast.error(errorMessage(error));
    setPassword("");
    toast.success("Password changed");
  };
  return (
    <Card className="space-y-5 p-5">
      <div className="text-sm"><div className="font-medium">{member.display_name}</div><div className="text-muted">{email} · {member.role}</div></div>
      <form onSubmit={change} className="flex max-w-sm items-end gap-2">
        <Field label="New password" className="flex-1">{(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" loading={busy}>Change</Button>
      </form>
      <Button variant="ghost" onClick={() => void signOut()}>Sign out of this device</Button>
    </Card>
  );
}
