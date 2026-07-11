"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const supabase = getBrowserClient();
  const [mode, setMode] = useState<"sign_in" | "sign_up">("sign_in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    if (mode === "sign_in") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else {
        router.push("/");
        router.refresh();
      }
    } else {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else if (!data.session) {
        setNotice("Check your inbox — Supabase sent a confirmation link. Sign in after confirming.");
      } else {
        router.push("/");
        router.refresh();
      }
    }
    setBusy(false);
  }

  const input =
    "w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1";

  return (
    <div className="flex min-h-screen items-center justify-center bg-page p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="text-lg font-semibold text-ink">SEO Opportunity Engine</h1>
        <p className="mt-1 text-sm text-ink-2">
          {mode === "sign_in" ? "Sign in to your workspace." : "Create your account."}
        </p>

        {!supabase ? (
          <p className="mt-4 rounded-md border border-edge bg-page p-3 text-sm text-ink-2">
            Supabase is not configured in this environment, so login is disabled and the app runs
            on fixture data. Copy <code>.env.example</code> to <code>.env.local</code> and fill in
            your project values to enable it.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-3">
            <label className="block text-sm text-ink-2">
              Email
              <input
                type="email"
                required
                autoComplete="email"
                className={`mt-1 ${input}`}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block text-sm text-ink-2">
              Password
              <input
                type="password"
                required
                minLength={8}
                autoComplete={mode === "sign_in" ? "current-password" : "new-password"}
                className={`mt-1 ${input}`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <p className="text-sm text-critical">⚠ {error}</p>}
            {notice && <p className="text-sm text-delta-good">{notice}</p>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-series-1 px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Working…" : mode === "sign_in" ? "Sign in" : "Create account"}
            </button>
            <button
              type="button"
              onClick={() => setMode(mode === "sign_in" ? "sign_up" : "sign_in")}
              className="w-full text-sm font-medium text-series-1 hover:underline"
            >
              {mode === "sign_in" ? "New here? Create an account" : "Already registered? Sign in"}
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}
