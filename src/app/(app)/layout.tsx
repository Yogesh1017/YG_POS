"use client";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { Button, ErrorNote, Spinner } from "@/components/ui";
import { useSession } from "@/lib/session";
import { startBackgroundSync } from "@/lib/sync";

export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, error, business, refresh, signOut } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === "signed_out") router.replace("/login/");
    if (status === "no_business") router.replace("/setup/");
  }, [status, router]);
  const businessId = status === "ready" ? business?.id : undefined;
  useEffect(() => (businessId ? startBackgroundSync(businessId) : undefined), [businessId]);
  useEffect(() => {
    // Ask the browser not to evict this site's storage under disk pressure (it holds un-uploaded bills).
    if (businessId) void navigator.storage?.persist?.().catch(() => undefined);
  }, [businessId]);

  if (status === "error") {
    return (
      <main className="mx-auto max-w-md space-y-3 p-6 pt-20">
        <ErrorNote onRetry={() => void refresh()}>{error}</ErrorNote>
        <Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button>
      </main>
    );
  }
  if (status !== "ready") return <Spinner />;
  return <AppShell>{children}</AppShell>;
}
