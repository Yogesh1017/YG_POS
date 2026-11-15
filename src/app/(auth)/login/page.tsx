"use client";
import { ReceiptText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ErrorNote, Field, Input } from "@/components/ui";
import { api, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function LoginPage() {
  const { status, error: sessionError, signIn, refresh } = useSession();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "recover" | "recovered">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "ready") router.replace("/");
    if (status === "needs_setup") router.replace("/setup/");
  }, [status, router]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        const r = await api<{ token: string }>("auth.login", { username, password });
        await signIn(r.token);
      } else {
        const r = await api<{ username: string; recovery_key: string }>("auth.recover", { recovery_key: key, password });
        setUsername(r.username);
        setNewKey(r.recovery_key);
        setPassword("");
        setMode("recovered");
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-fg"><ReceiptText className="size-5" /></span>
          <span className="text-lg font-semibold tracking-tight">YG POS</span>
        </div>
        {status === "error" && <div className="mb-4"><ErrorNote onRetry={() => void refresh()}>{sessionError}</ErrorNote></div>}
        <div className="rounded-xl border border-border bg-surface p-6">
          {mode === "recovered" ? (
            <div className="flex flex-col gap-3">
              <h1 className="text-lg font-semibold">Password changed</h1>
              <p className="text-sm text-muted">The owner username is <b className="text-text">{username}</b>. Your old recovery key no longer works. Write down the new one:</p>
              <p className="num rounded-lg bg-surface-2 px-3 py-3 text-center text-lg font-semibold tracking-wider select-all">{newKey}</p>
              <Button variant="primary" onClick={() => setMode("login")}>Go to sign in</Button>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
              <h1 className="text-lg font-semibold">{mode === "login" ? "Sign in" : "Reset the owner password"}</h1>
              {mode === "login"
                ? <Field label="Username">{(p) => <Input {...p} autoFocus autoCapitalize="none" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
                : <Field label="Recovery key" hint="The key you wrote down when the app was set up.">{(p) => <Input {...p} autoFocus className="num uppercase" value={key} onChange={(e) => setKey(e.target.value)} />}</Field>}
              <Field label={mode === "login" ? "Password" : "New password"}>{(p) => <Input {...p} type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
              {error && <p role="alert" className="text-sm text-danger">{error}</p>}
              <Button type="submit" variant="primary" loading={busy}>{mode === "login" ? "Sign in" : "Reset password"}</Button>
              <button type="button" className="text-left text-sm text-muted hover:underline" onClick={() => { setError(""); setMode(mode === "login" ? "recover" : "login"); }}>
                {mode === "login" ? "Owner forgot the password?" : "Back to sign in"}
              </button>
              {mode === "login" && <p className="text-xs text-muted">Staff who forget their password: ask the owner to set a new one in Settings → Users.</p>}
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
