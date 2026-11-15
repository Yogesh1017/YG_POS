"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BusinessForm, businessDefaults } from "@/components/business-form";
import { Button, Field, Input, Spinner } from "@/components/ui";
import { useSession } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";

export default function SetupPage() {
  const { status, email, refresh, signOut } = useSession();
  const router = useRouter();
  const [ownerName, setOwnerName] = useState("");
  useEffect(() => {
    if (status === "signed_out") router.replace("/login/");
    if (status === "ready") router.replace("/");
  }, [status, router]);
  if (status !== "no_business") return <Spinner />;

  return (
    <main className="mx-auto max-w-2xl p-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Set up your shop</h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        Signed in as {email}. Joining as staff instead? Ask the owner to add this email under Settings → Staff, then reload this page.
      </p>
      <div className="rounded-xl border border-border bg-surface p-6">
        <Field label="Your name" hint="Shown on bills as “Billed by”." className="mb-6 max-w-xs">
          {(p) => <Input {...p} value={ownerName} maxLength={80} onChange={(e) => setOwnerName(e.target.value)} />}
        </Field>
        <BusinessForm mode="setup" initial={businessDefaults()} submitLabel="Create shop" onSubmit={async (values) => {
          const { error } = await supabase().rpc("create_business", { p: { ...values, owner_name: ownerName.trim() } });
          if (error) { toast.error(errorMessage(error)); return; }
          toast.success("Shop created");
          await refresh();
        }} />
      </div>
      <div className="mt-4 flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => void refresh()}>Reload</Button>
        <Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button>
      </div>
    </main>
  );
}
