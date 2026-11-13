"use client";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { ReceiptText } from "lucide-react";
import { useSession } from "@/lib/session";
import { ErrorNote } from "@/components/ui";

export default function AuthLayout({ children }: { children: ReactNode }) {
  const { status, error } = useSession();
  const router = useRouter();
  const onReset = typeof window !== "undefined" && window.location.pathname.startsWith("/reset-password");
  useEffect(() => {
    if (onReset) return;
    if (status === "ready") router.replace("/");
    if (status === "no_business") router.replace("/setup/");
  }, [status, router, onReset]);

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-fg"><ReceiptText className="size-5" /></span>
          <span className="text-lg font-semibold tracking-tight">YG POS</span>
        </div>
        {status === "error" && error && <div className="mb-4"><ErrorNote>{error}</ErrorNote></div>}
        <div className="rounded-xl border border-border bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}
