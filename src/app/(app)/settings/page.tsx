"use client";
import { FolderOpen, HardDriveDownload, RotateCcw, SearchCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Page } from "@/components/app-shell";
import { BusinessFields, businessDefaults, businessPayload, useBusinessForm } from "@/components/business-form";
import { Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, ErrorNote, Field, Input, PageHeader, Select, Spinner, cn, td, th } from "@/components/ui";
import { api, errorText, formatDateTime, setToken, useApi } from "@/lib/api";
import { formatINR } from "@/lib/money";
import { desktop } from "@/lib/print";
import { useSession, useShop } from "@/lib/session";
import type { Role, User } from "@/lib/types";

type Tab = "business" | "users" | "printing" | "backup" | "account";
interface BackupInfo { file: string; name: string; size: number; taken_at: string; kind: string; business_name?: string; last_invoice?: string | null; invoices?: number; customer_dues?: number; stock_value?: number; schema_version?: number }
interface BackupStatus { folder: string; second_folder: string | null; last_backup_at: string | null; last_backup_2_at: string | null; warning: string | null; backups: BackupInfo[] }

export default function SettingsPage() {
  const { isOwner, canManage } = useShop();
  const [tab, setTab] = useState<Tab>(isOwner ? "business" : "printing");
  useEffect(() => { const t = new URLSearchParams(window.location.search).get("tab") as Tab | null; if (t) setTab(t); }, []);
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "business", label: "Business and GST", show: isOwner }, { id: "users", label: "Users", show: isOwner }, { id: "printing", label: "Printing", show: true },
    { id: "backup", label: "Backup and restore", show: canManage }, { id: "account", label: "My account", show: true },
  ];
  return (
    <Page className="max-w-4xl">
      <PageHeader title="Settings" />
      <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
        {tabs.filter((t) => t.show).map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap", tab === t.id ? "border-primary text-primary" : "border-transparent text-muted hover:text-text")}>{t.label}</button>)}
      </div>
      {tab === "business" && isOwner && <BusinessTab />}
      {tab === "users" && isOwner && <UsersTab />}
      {tab === "printing" && <PrintingTab />}
      {tab === "backup" && canManage && <BackupTab />}
      {tab === "account" && <AccountTab />}
    </Page>
  );
}

function BusinessTab() {
  const { settings, refresh } = useShop();
  const { v, set } = useBusinessForm(businessDefaults(settings));
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api("settings.update", businessPayload(v)); await refresh(); toast.success("Settings saved"); }
    catch (err) { toast.error(errorText(err)); }
    finally { setBusy(false); }
  };
  return <Card className="p-5"><form onSubmit={submit} noValidate className="flex flex-col gap-6"><BusinessFields v={v} set={set} full /><div><Button type="submit" variant="primary" loading={busy}>Save settings</Button></div></form></Card>;
}

function UsersTab() {
  const { user: me } = useShop();
  const q = useApi<User[]>("users.list");
  const [v, setV] = useState({ display_name: "", username: "", password: "", role: "cashier" as Role });
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api("users.create", v); toast.success(`${v.display_name} added`); setV({ display_name: "", username: "", password: "", role: "cashier" }); await q.reload(); }
    catch (err) { toast.error(errorText(err)); }
    finally { setBusy(false); }
  };
  const update = async (u: User, patch: Partial<{ role: Role; is_active: boolean; password: string }>) => {
    try { await api("users.update", { id: u.id, display_name: u.display_name, role: patch.role ?? u.role, is_active: patch.is_active ?? !!u.is_active, password: patch.password ?? null }); toast.success("Updated"); await q.reload(); }
    catch (err) { toast.error(errorText(err)); }
  };
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        {q.error ? <div className="p-4"><ErrorNote onRetry={q.reload}>{q.error}</ErrorNote></div> : !q.data ? <Spinner /> : (
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Name</th><th className={th}>Username</th><th className={th}>Role</th><th className={th} /></tr></thead>
            <tbody className="divide-y divide-border">{q.data.map((u) => (
              <tr key={u.id} className={u.is_active ? "" : "opacity-60"}>
                <td className={`${td} font-medium`}>{u.display_name} {u.id === me.id && <Badge>You</Badge>} {!u.is_active && <Badge tone="danger">Access removed</Badge>}</td>
                <td className={`${td} num text-muted`}>{u.username}</td>
                <td className={td}>{u.role === "owner" ? "Owner" : <Select aria-label={`Role of ${u.display_name}`} className="h-8 w-32" value={u.role} onChange={(e) => void update(u, { role: e.target.value as Role })}><option value="manager">Manager</option><option value="cashier">Cashier</option></Select>}</td>
                <td className={`${td} whitespace-nowrap text-right`}>{u.role !== "owner" && <><Button size="sm" onClick={() => setResetting(u)}>Set password</Button>{" "}<Button size="sm" onClick={() => void update(u, { is_active: !u.is_active })}>{u.is_active ? "Remove access" : "Restore access"}</Button></>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="text-sm font-semibold">Add a user</h2>
        <p className="mt-1 mb-4 text-sm text-muted"><b>Cashiers</b> make invoices at list, quantity and customer prices, see invoices, add customers and record payments. <b>Managers</b> can also change rates, approve exceptions, manage products, stock, purchases, suppliers and expenses, cancel invoices, take returns and see reports. Only the <b>owner</b> changes business settings, users and restores backups.</p>
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto] sm:items-end">
          <Field label="Name">{(p) => <Input {...p} value={v.display_name} onChange={(e) => setV({ ...v, display_name: e.target.value })} />}</Field>
          <Field label="Username">{(p) => <Input {...p} autoCapitalize="none" autoComplete="off" value={v.username} onChange={(e) => setV({ ...v, username: e.target.value })} />}</Field>
          <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="new-password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} />}</Field>
          <Field label="Role">{(p) => <Select {...p} value={v.role} onChange={(e) => setV({ ...v, role: e.target.value as Role })}><option value="cashier">Cashier</option><option value="manager">Manager</option></Select>}</Field>
          <Button type="submit" variant="primary" loading={busy}>Add</Button>
        </form>
      </Card>
      <ConfirmDialog open={!!resetting} title={`New password for ${resetting?.display_name ?? ""}`} confirmLabel="Set password" reasonLabel="New password (at least 6 characters)" onClose={() => setResetting(null)}
        message="They will be signed out and must use the new password." onConfirm={async (pw) => { await update(resetting!, { password: pw }); setResetting(null); }} />
    </div>
  );
}

function PrintingTab() {
  const cfg = useApi<Record<string, string>>("config.get");
  const [printers, setPrinters] = useState<{ name: string; label: string }[] | null>(null);
  useEffect(() => { void desktop()?.printers().then(setPrinters).catch(() => setPrinters([])); }, []);
  const save = async (key: string, value: string) => { try { await api("config.set", { key, value }); await cfg.reload(); toast.success("Saved"); } catch (e) { toast.error(errorText(e)); } };
  if (!cfg.data) return <Spinner />;
  const inApp = !!desktop();
  const printerSelect = (key: string, label: string) => (
    <Field label={label} hint={inApp ? undefined : "Printer choice is available inside the desktop app."}>{(p) => (
      <Select {...p} disabled={!inApp} value={cfg.data![key] ?? ""} onChange={(e) => void save(key, e.target.value)}>
        <option value="">Ask each time (system print dialog)</option>
        {(printers ?? []).map((pr) => <option key={pr.name} value={pr.name}>{pr.label}</option>)}
      </Select>
    )}</Field>
  );
  return (
    <Card className="space-y-5 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {printerSelect("a4_printer", "Printer for A4 invoices")}
        {printerSelect("thermal_printer", "Thermal receipt printer")}
        <Field label="Thermal paper width">{(p) => <Select {...p} value={cfg.data!.thermal_width ?? "80mm"} onChange={(e) => void save("thermal_width", e.target.value)}><option value="80mm">80 mm</option><option value="58mm">58 mm</option></Select>}</Field>
        <div className="flex items-end pb-2"><Checkbox label="Print straight away, without the print dialog" hint="Only for a printer chosen above." disabled={!inApp} checked={cfg.data.silent_print === "1"} onChange={(e) => void save("silent_print", e.target.checked ? "1" : "0")} /></div>
      </div>
      <div className="space-y-1.5 text-sm text-muted">
        <p className="font-medium text-text">Hardware notes</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Install each printer in Windows first (with its driver) and print a Windows test page. YG POS prints through Windows.</li>
          <li>For a thermal printer, set the paper size in the Windows printer preferences to match the roll (80 mm or 58 mm).</li>
          <li>“Save PDF” on any invoice writes a real PDF file you can keep or send.</li>
          <li>A barcode scanner that types like a keyboard works in every product search box. Set it to send Enter after each scan.</li>
          <li>A cash drawer wired to the receipt printer opens through the printer driver&apos;s “open drawer when printing” option.</li>
        </ul>
      </div>
    </Card>
  );
}

function BackupTab() {
  const { isOwner } = useShop();
  const { refresh } = useSession();
  const q = useApi<BackupStatus>("backup.status");
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState("");
  const [checked, setChecked] = useState<BackupInfo | null>(null);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [manualPath, setManualPath] = useState("");
  useEffect(() => { if (q.data) setFolder(q.data.second_folder ?? ""); }, [q.data]);
  const s = q.data;

  const backupNow = async () => {
    setBusy(true);
    try {
      const r = await api<BackupInfo & { second: string; second_error?: string }>("backup.now");
      if (r.second === "failed") toast.warning(`Backup saved on this computer, but NOT copied to the second location: ${r.second_error}`);
      else toast.success(r.second === "ok" ? "Backup saved and copied to the second location" : "Backup saved on this computer");
      await q.reload();
    } catch (e) { toast.error(errorText(e)); }
    finally { setBusy(false); }
  };
  const saveFolder = async (value: string) => {
    try { await api("config.set", { key: "backup_dir_2", value }); toast.success(value ? "Second backup location saved. Taking a backup now to test it…" : "Second backup location removed"); if (value) await backupNow(); else await q.reload(); }
    catch (e) { toast.error(errorText(e)); }
  };
  const inspect = async (file: string) => { try { setChecked(await api<BackupInfo>("backup.inspect", { file })); } catch (e) { toast.error(errorText(e)); } };
  const pickFile = async () => { const f = await desktop()?.pickBackupFile(); if (f) await inspect(f); };

  if (q.error) return <ErrorNote onRetry={q.reload}>{q.error}</ErrorNote>;
  if (!s) return <Spinner />;
  return (
    <div className="space-y-4">
      {s.warning ? <p role="alert" className="rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">{s.warning}</p>
        : <p className="rounded-lg border border-border bg-primary-soft px-4 py-3 text-sm text-primary">Backups are up to date in both locations.</p>}
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p>Last backup: <b>{s.last_backup_at ? formatDateTime(s.last_backup_at) : "never"}</b>{s.second_folder && <> · second location: <b>{s.last_backup_2_at ? formatDateTime(s.last_backup_2_at) : "never"}</b></>}</p>
            <p className="mt-1 text-muted">A backup is taken automatically when the app opens, every two hours while it is open, and when it closes. Each one is checked after it is written.</p>
          </div>
          <Button variant="primary" loading={busy} onClick={() => void backupNow()}><HardDriveDownload className="size-4" /> Back up now</Button>
        </div>
        <div className="text-sm">
          <p className="text-muted">On this computer: <span className="num text-text">{s.folder}</span> {desktop() && <Button size="sm" variant="ghost" onClick={() => void desktop()!.openFolder(s.folder)}><FolderOpen className="size-4" /> Open</Button>}</p>
        </div>
        {isOwner && (
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void saveFolder(folder.trim()); }}>
            <Field label="Second backup location (USB or external drive)" hint="Backups on the same disk as the app do not protect you if that disk fails." className="min-w-64 flex-1">{(p) => <Input {...p} className="num" placeholder="E:\YG-POS-Backups" value={folder} onChange={(e) => setFolder(e.target.value)} />}</Field>
            {desktop() && <Button onClick={async () => { const f = await desktop()!.pickFolder(); if (f) { setFolder(f); await saveFolder(f); } }}><FolderOpen className="size-4" /> Choose folder</Button>}
            <Button type="submit">Save</Button>
          </form>
        )}
      </Card>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 pb-2">
          <h2 className="text-sm font-semibold">Backups on this computer</h2>
          {isOwner && (desktop() ? <Button size="sm" onClick={() => void pickFile()}><SearchCheck className="size-4" /> Check or restore another file…</Button> : (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (manualPath.trim()) void inspect(manualPath.trim()); }}>
              <Input aria-label="Path of a backup file" className="num h-8 w-72" placeholder="Full path of a backup file" value={manualPath} onChange={(e) => setManualPath(e.target.value)} /><Button size="sm" type="submit">Check file</Button>
            </form>
          ))}
        </div>
        {s.backups.length === 0 ? <p className="px-4 pb-4 text-sm text-muted">No backups yet.</p> : (
          <div className="max-h-96 overflow-y-auto"><table className="w-full text-sm">
            <thead className="border-b border-border bg-surface-2/60"><tr><th className={th}>Taken</th><th className={th}>Type</th><th className={`${th} text-right`}>Size</th><th className={th} /></tr></thead>
            <tbody className="divide-y divide-border">{s.backups.map((b) => (
              <tr key={b.name}><td className={td}>{formatDateTime(b.taken_at)}</td><td className={`${td} text-muted`}>{b.kind}</td><td className={`${td} num text-right text-muted`}>{(b.size / 1024).toFixed(0)} KB</td>
                <td className={`${td} text-right`}>{isOwner && <Button size="sm" onClick={() => void inspect(b.file)}><SearchCheck className="size-4" /> Check</Button>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      <p className="text-xs text-muted">Test a restore now and then: press Check on last night&apos;s backup and confirm the last invoice number and the amount customers owe match your records.</p>

      {checked && (
        <Dialog open onClose={() => setChecked(null)} title="Backup check" footer={<><Button onClick={() => setChecked(null)}>Close</Button><Button variant="danger" onClick={() => { setRestoring(checked); setChecked(null); }}><RotateCcw className="size-4" /> Restore this backup…</Button></>}>
          <p className="mb-3 rounded-md bg-primary-soft px-3 py-2 text-sm text-primary">This file is a complete, undamaged YG POS backup.</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
            <dt className="text-muted">Taken</dt><dd>{formatDateTime(checked.taken_at)}</dd>
            <dt className="text-muted">Business</dt><dd>{checked.business_name}</dd>
            <dt className="text-muted">Last invoice</dt><dd className="num font-medium">{checked.last_invoice ?? "none"}</dd>
            <dt className="text-muted">Invoices</dt><dd className="num">{checked.invoices}</dd>
            <dt className="text-muted">Customers owe</dt><dd className="num">{formatINR(checked.customer_dues ?? 0)}</dd>
            <dt className="text-muted">Stock value</dt><dd className="num">{formatINR(checked.stock_value ?? 0)}</dd>
            <dt className="text-muted">File</dt><dd className="num break-all text-xs text-muted">{checked.file}</dd>
          </dl>
        </Dialog>
      )}
      <ConfirmDialog open={!!restoring} danger title="Restore this backup?" confirmLabel="Restore" reasonLabel="Type RESTORE to confirm" onClose={() => setRestoring(null)}
        message={<>All data will go back to how it was on <b>{restoring && formatDateTime(restoring.taken_at)}</b> (last invoice <b className="num">{restoring?.last_invoice ?? "none"}</b>). Everything entered after that will no longer be in the app. Your current data is saved first as a “pre-restore” backup, so this can be undone. Everyone will be signed out.</>}
        onConfirm={async (word) => {
          if (word !== "RESTORE") return void toast.error("Type RESTORE in capitals to confirm.");
          try { await api("backup.restore", { file: restoring!.file }); setToken(null); toast.success("Backup restored. Sign in again."); setRestoring(null); await refresh(); }
          catch (e) { toast.error(errorText(e)); }
        }} />
    </div>
  );
}

function AccountTab() {
  const { user } = useShop();
  const { signOut } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState("");
  useEffect(() => { void desktop()?.version().then(setVersion); }, []);
  const change = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try { await api("auth.changePassword", { current, next }); setCurrent(""); setNext(""); toast.success("Password changed"); }
    catch (err) { toast.error(errorText(err)); }
    finally { setBusy(false); }
  };
  return (
    <Card className="space-y-5 p-5">
      <div className="text-sm"><div className="font-medium">{user.display_name}</div><div className="text-muted">{user.username} · {user.role}</div></div>
      <form onSubmit={change} className="grid max-w-md grid-cols-2 items-end gap-3">
        <Field label="Current password">{(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
        <Field label="New password">{(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
        <div><Button type="submit" loading={busy}>Change password</Button></div>
      </form>
      <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
      {version && <p className="text-xs text-muted">YG POS version {version}</p>}
    </Card>
  );
}
