"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Boxes, LayoutDashboard, LogOut, Menu, Moon, Package, ReceiptText, ScanBarcode, Settings, Sun, Users, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { SyncStatus } from "@/components/sync-status";
import { cn } from "@/components/ui";
import { db } from "@/lib/db";
import { useSession, useShop } from "@/lib/session";
import type { Role } from "@/lib/types";

const NAV: { href: string; label: string; icon: typeof Package; roles: Role[] }[] = [
  { href: "/pos/", label: "Billing", icon: ScanBarcode, roles: ["owner", "manager", "cashier"] },
  { href: "/sales/", label: "Sales", icon: ReceiptText, roles: ["owner", "manager", "cashier"] },
  { href: "/products/", label: "Products", icon: Package, roles: ["owner", "manager"] },
  { href: "/inventory/", label: "Stock", icon: Boxes, roles: ["owner", "manager"] },
  { href: "/customers/", label: "Customers", icon: Users, roles: ["owner", "manager", "cashier"] },
  { href: "/", label: "Dashboard", icon: LayoutDashboard, roles: ["owner", "manager"] },
  { href: "/reports/", label: "Reports", icon: BarChart3, roles: ["owner", "manager"] },
  { href: "/settings/", label: "Settings", icon: Settings, roles: ["owner", "manager", "cashier"] },
];

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
  const { business, member, role } = useShop();
  const { signOut } = useSession();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href.replace(/\/$/, "")));

  const handleSignOut = async () => {
    const waiting = await db.sales.where({ business_id: business.id, status: "pending" }).count();
    if (waiting > 0 && !window.confirm(`${waiting} bill(s) have not been uploaded yet. They stay on this device and upload after the next sign-in here. Sign out anyway?`)) return;
    await signOut();
  };

  const sidebar = (
    <>
      <div className="px-4 pt-4 pb-3">
        <div className="truncate font-semibold tracking-tight">{business.name}</div>
        <div className="truncate text-xs text-muted">{member.display_name} · {role}</div>
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
        <SyncStatus businessId={business.id} />
        <ThemeToggle />
        <button onClick={() => void handleSignOut()} className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted hover:bg-surface-2">
          <LogOut className="size-4" /> Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-dvh">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-surface lg:flex">{sidebar}</aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-surface px-3 py-2 lg:hidden">
          <button onClick={() => setMenuOpen(true)} aria-label="Open menu" className="rounded-md p-2 hover:bg-surface-2"><Menu className="size-5" /></button>
          <span className="truncate font-semibold">{business.name}</span>
          <div className="w-9"><SyncStatus businessId={business.id} compact /></div>
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
