"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { BusinessFields, businessDefaults, businessPayload, useBusinessForm } from "@/components/business-form";
import { Button, Field, Input, Spinner } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";

// First run on a new computer: create the owner's login and the business profile.
export default function SetupPage() {
  const { status, signIn } = useSession();
  const router = useRouter();
  const { v, set } = useBusinessForm(businessDefaults());
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ token: string; recovery_key: string } | null>(null);

  useEffect(() => {
    if (done) return;
    if (status === "signed_out") router.replace("/login/");
    if (status === "ready") router.replace("/");
  }, [status, router, done]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords do not match.");
    setError("");
    setBusy(true);
    try {
      setDone(await api("setup.create", { username, display_name: name, password, business: businessPayload(v) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <main className="mx-auto max-w-lg p-4 py-16">
        <div className="rounded-xl border border-border bg-surface p-6">
          <h1 className="text-xl font-semibold tracking-tight">Write down your recovery key</h1>
          <p className="mt-2 text-sm text-muted">If you ever forget the owner password, this key is the only way to reset it. It is shown once. Write it on paper and keep it somewhere safe, away from this computer.</p>
          <p className="num my-5 rounded-lg bg-surface-2 px-4 py-4 text-center text-xl font-semibold tracking-wider select-all" data-testid="recovery-key">{done.recovery_key}</p>
          <Button variant="primary" onClick={async () => { await signIn(done.token); router.replace("/"); }}>I have written it down</Button>
        </div>
      </main>
    );
  }
  if (status !== "needs_setup") return <Spinner />;
  return (
    <main className="mx-auto max-w-2xl p-4 py-10">
      <h1 className="text-xl font-semibold tracking-tight">Set up YG POS on this computer</h1>
      <p className="mt-1 mb-6 text-sm text-muted">All data stays on this computer. No internet connection is needed.</p>
      <form onSubmit={submit} noValidate className="flex flex-col gap-6 rounded-xl border border-border bg-surface p-6">
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-3 text-sm font-semibold">Owner login</legend>
          <Field label="Your name">{(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Username" hint="Used to sign in. Letters and digits.">{(p) => <Input {...p} autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
          <Field label="Password" hint="At least 6 characters">{(p) => <Input {...p} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Field label="Password again">{(p) => <Input {...p} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        </fieldset>
        <BusinessFields v={v} set={set} full={false} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div><Button type="submit" variant="primary" loading={busy}>Create and continue</Button></div>
      </form>
    </main>
  );
}
