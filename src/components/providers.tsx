"use client";
import { useEffect, type ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { SessionProvider } from "@/lib/session";

export function Providers({ children }: { children: ReactNode }) {
  useEffect(() => {
    // The service worker keeps the app itself available offline. Production builds only.
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let reloading = false;
    const onControllerChange = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    const offerUpdate = (worker: ServiceWorker) => {
      toast("A new version of YG POS is ready", {
        duration: Infinity,
        action: {
          label: "Update now",
          onClick: () => {
            navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
            worker.postMessage("SKIP_WAITING");
          },
        },
      });
    };
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // Only offer an update when an older version is already running this page.
      if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const next = reg.installing;
        next?.addEventListener("statechange", () => {
          if (next.state === "installed" && navigator.serviceWorker.controller) offerUpdate(next);
        });
      });
    }).catch((e) => console.error("Service worker registration failed", e));
  }, []);
  return (
    <SessionProvider>
      {children}
      <Toaster position="top-center" richColors closeButton toastOptions={{ style: { fontFamily: "var(--font-sans)" } }} />
    </SessionProvider>
  );
}
