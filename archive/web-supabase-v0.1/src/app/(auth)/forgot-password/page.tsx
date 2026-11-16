"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { isNetworkError, supabase } from "@/lib/supabase";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Enter a valid email address");
    setError("");
    setBusy(true);
    const { error: err } = await supabase().auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password/`,
    });
    setBusy(false);
    if (err) return setError(isNetworkError(err) ? "No internet connection." : err.message);
    setSent(true);
  };

  if (sent) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="text-sm text-muted">If an account exists for <b className="text-text">{email}</b>, a link to set a new password is on its way.</p>
        <Link href="/login/" className="text-sm font-medium text-primary hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div>
        <h1 className="text-lg font-semibold">Reset password</h1>
        <p className="mt-1 text-sm text-muted">We will email you a link to choose a new password.</p>
      </div>
      <Field label="Email" error={error}>{(p) => <Input {...p} type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Button type="submit" variant="primary" loading={busy}>Send reset link</Button>
      <Link href="/login/" className="text-sm text-muted hover:underline">Back to sign in</Link>
    </form>
  );
}
