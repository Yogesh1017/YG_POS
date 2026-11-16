"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { credentialsSchema, fieldErrors } from "@/lib/schemas";
import { isNetworkError, supabase } from "@/lib/supabase";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError("");
    const parsed = credentialsSchema.safeParse({ email, password });
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    const { error } = await supabase().auth.signInWithPassword(parsed.data);
    setBusy(false);
    if (error) {
      setFormError(isNetworkError(error) ? "No internet connection. Signing in needs to be online." :
        /confirm/i.test(error.message) ? "Confirm your email first — check your inbox for the link." :
        /invalid/i.test(error.message) ? "Wrong email or password." : error.message);
    }
    // On success the session listener redirects.
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <h1 className="text-lg font-semibold">Sign in</h1>
      <Field label="Email" error={errors.email}>{(p) => <Input {...p} type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Password" error={errors.password}>{(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
      <Button type="submit" variant="primary" loading={busy}>Sign in</Button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password/" className="text-muted underline-offset-2 hover:underline">Forgot password?</Link>
        <Link href="/register/" className="font-medium text-primary underline-offset-2 hover:underline">Create account</Link>
      </div>
    </form>
  );
}
