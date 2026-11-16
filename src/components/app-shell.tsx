"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Boxes, HardDriveDownload, LayoutDashboard, LogOut, Menu, Moon, Package, ReceiptText, ScrollText, Settings, Sun, Truck, Users, Wallet, X, Factory } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useSession, useShop } from "@/lib/session";
import type { Role } from "@/lib/types";

const ALL: Role[] = ["owner", "manager", "cashier"], MGR: Role[] = ["owner", "manager"];
const NAV: { href: string; label: string; icon: typeof Package; roles: Role[]; key?: string }[] = [
  { href: "/billing/", label: "New invoice", icon: ScrollText, roles: ALL, key: "F1" },
  { href: "/sales/", label: "Invoices", icon: ReceiptText, roles: ALL },
  { href: "/customers/", label: "Customers", icon: Users, roles: ALL },
  { href: "/products/", label: "Products", icon: Package, roles: MGR },
  { href: "/inventory/", label: "Stock", icon: Boxes, roles: MGR },
  { href: "/purchases/", label: "Purchases", icon: Truck, roles: MGR },
  { href: "/suppliers/", label: "Suppliers", icon: Factory, roles: MGR },
  { href: "/expenses/", label: "Expenses", icon: Wallet, roles: MGR },
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ALL },
  { href: "/reports/", label: "Reports", icon: BarChart3, roles: MGR },
  { href: "/settings/", label: "Settings", icon: Settings, roles: ALL },
];

/** Shows whether backups are healthy; owner/manager only. */
function BackupBadge() {
  const { data } = useApi<{ warning: string | null }>("backup.status");
  if (!data) return null;
  return (
    <Link href="/settings/?tab=backup" title={data.warning ?? "Backups are up to date"} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-surface-2", data.warning ? "text-warn" : "text-muted")}>
      <HardDriveDownload className="size-4 shrink-0" aria-hidden /> {data.warning ? "Backup needs attention" : "Backups OK"}
    </Link>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("ygpos-theme", next ? "dark" : "light");
    setDark(next);
  };
  return (
    <button onClick={toggle} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted hover:bg-surface-2">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />} {dark ? "Light theme" : "Dark theme"}
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { settings, user, role, canManage } = useShop();
  const { signOut } = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href.replace(/\/$/, "")));

  const sidebar = (
    <>
      <div className="px-4 pt-4 pb-3">
        <div className="truncate font-semibold tracking-tight">{settings.business_name}</div>
        <div className="truncate text-xs text-muted">{user.display_name} · {role}</div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2" aria-label="Main">
        {NAV.filter((n) => n.roles.includes(role)).map((n) => (
          <Link key={n.href} href={n.href} aria-current={isActive(n.href) ? "page" : undefined} className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium",
            isActive(n.href) ? "bg-primary text-primary-fg" : "text-text hover:bg-surface-2",
          )}>
            <n.icon className="size-4" aria-hidden /> {n.label}
          </Link>
        ))}
      </nav>
      <div className="space-y-0.5 border-t border-border p-2">
        {canManage && <BackupBadge />}
        <ThemeToggle />
        <button onClick={() => void signOut()} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted hover:bg-surface-2">
          <LogOut className="size-4" /> Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-surface lg:flex">{sidebar}</aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-3 py-2 lg:hidden">
          <button onClick={() => setMenuOpen(true)} aria-label="Open menu" className="rounded-md p-2 hover:bg-surface-2"><Menu className="size-5" /></button>
          <span className="truncate font-semibold">{settings.business_name}</span>
        </header>
        {menuOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-black/50" onClick={() => setMenuOpen(false)} />
            <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface shadow-xl">
              <button onClick={() => setMenuOpen(false)} aria-label="Close menu" className="absolute top-3 right-3 rounded-md p-1.5 hover:bg-surface-2"><X className="size-4" /></button>
              {sidebar}
            </aside>
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

/** Wrap a screen that only owners/managers may open. (The database enforces this too; this is for a clear message.) */
export function ManagersOnly({ children }: { children: ReactNode }) {
  const { canManage } = useShop();
  if (!canManage) {
    return <div className="p-10 text-center text-sm text-muted">This screen is for the owner or a manager. Ask them if you need something changed here.</div>;
  }
  return <>{children}</>;
}

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-6xl p-4 lg:p-6", className)}>{children}</div>;
}
