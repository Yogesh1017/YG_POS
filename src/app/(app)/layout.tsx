"use client";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { ErrorNote, Spinner } from "@/components/ui";
import { useSession } from "@/lib/session";

export default function AppLayout({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (status === "signed_out") router.replace("/login/");
    if (status === "needs_setup") router.replace("/setup/");
  }, [status, router]);
  // F1 from anywhere starts a new invoice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F1") { e.preventDefault(); router.push("/billing/"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  if (status === "error") return <main className="mx-auto max-w-md p-6 pt-20"><ErrorNote onRetry={() => void refresh()}>{error}</ErrorNote></main>;
  if (status !== "ready") return <Spinner />;
  return <AppShell>{children}</AppShell>;
}
