"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { credentialsSchema, fieldErrors } from "@/lib/schemas";
import { isNetworkError, supabase } from "@/lib/supabase";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError("");
    const parsed = credentialsSchema.safeParse({ email, password });
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    const { data, error } = await supabase().auth.signUp({
      ...parsed.data, options: { emailRedirectTo: `${window.location.origin}/login/` },
    });
    setBusy(false);
    if (error) return setFormError(isNetworkError(error) ? "No internet connection." : error.message);
    // With email confirmation switched on, there is no session until the link is clicked.
    if (!data.session) setCheckEmail(true);
  };

  if (checkEmail) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="text-sm text-muted">We sent a confirmation link to <b className="text-text">{email}</b>. Open it, then sign in.</p>
        <Link href="/login/" className="text-sm font-medium text-primary hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div>
        <h1 className="text-lg font-semibold">Create your account</h1>
        <p className="mt-1 text-sm text-muted">Shop owners set up the shop next. Staff: sign up here, then ask the owner to add your email.</p>
      </div>
      <Field label="Email" error={errors.email}>{(p) => <Input {...p} type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Password" error={errors.password} hint="At least 8 characters">{(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
      <Button type="submit" variant="primary" loading={busy}>Create account</Button>
      <p className="text-sm text-muted">Already registered? <Link href="/login/" className="font-medium text-primary hover:underline">Sign in</Link></p>
    </form>
  );
}
