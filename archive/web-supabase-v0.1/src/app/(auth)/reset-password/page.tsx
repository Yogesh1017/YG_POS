"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Field, Input, Spinner } from "@/components/ui";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";

// Reached from the emailed recovery link, which signs the user in for this one purpose.
export default function ResetPasswordPage() {
  const { status } = useSession();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError("Use at least 8 characters");
    setError("");
    setBusy(true);
    const { error: err } = await supabase().auth.updateUser({ password });
    setBusy(false);
    if (err) return setError(err.message);
    toast.success("Password changed");
    router.replace("/");
  };

  if (status === "loading") return <Spinner />;
  if (status === "signed_out") {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold">Link expired</h1>
        <p className="text-sm text-muted">This password reset link is no longer valid. Request a new one.</p>
        <Link href="/forgot-password/" className="text-sm font-medium text-primary hover:underline">Send a new link</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <Field label="New password" error={error} hint="At least 8 characters">{(p) => <Input {...p} type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Button type="submit" variant="primary" loading={busy}>Save password</Button>
    </form>
  );
}
