"use client";
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import { SessionProvider } from "@/lib/session";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      {children}
      <Toaster position="top-center" richColors closeButton toastOptions={{ style: { fontFamily: "var(--font-sans)" } }} />
    </SessionProvider>
  );
}
