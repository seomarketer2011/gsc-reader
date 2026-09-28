"use client";

import { useEffect, useState } from "react";

interface Status {
  zones?: number;
  connected?: number;
  remaining?: number;
  needsReauth?: boolean;
  error?: string;
}

interface BatchResult {
  connected: string[];
  failed: { domain: string; step: string; error: string }[];
  remaining: number;
  needsReauth?: boolean;
  error?: string;
}

/** Drives /api/google/network-connect: shows how many Cloudflare zones are
 * registered in Search Console, and connects the rest one batch per press —
 * verification token → TXT record → verify → register, all server-side. */
export function NetworkConnect() {
  const [status, setStatus] = useState<Status | null>(null);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [failures, setFailures] = useState<BatchResult["failed"]>([]);

  async function refresh() {
    try {
      const res = await fetch("/api/google/network-connect");
      setStatus((await res.json()) as Status);
    } catch {
      setStatus({ error: "Could not load status" });
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function runBatch() {
    setRunning(true);
    setFailures([]);
    try {
      const res = await fetch("/api/google/network-connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const data = (await res.json()) as BatchResult;
      if (data.needsReauth) {
        setStatus((s) => ({ ...s, needsReauth: true, error: data.error }));
      } else if (!res.ok) {
        setLog((l) => [`Batch failed: ${data.error ?? res.status}`, ...l]);
      } else {
        setLog((l) =>
          [
            `Connected ${data.connected.length}${data.failed.length ? `, ${data.failed.length} failed` : ""} — ${data.remaining} remaining`,
            ...l,
          ].slice(0, 8),
        );
        setFailures(data.failed);
      }
      await refresh();
    } catch (e) {
      setLog((l) => [`Batch failed: ${e instanceof Error ? e.message : "network error"}`, ...l]);
    } finally {
      setRunning(false);
    }
  }

  if (!status) return <p className="text-sm text-muted">Checking Cloudflare zones…</p>;

  if (status.needsReauth) {
    return (
      <p className="text-sm text-ink-2">
        The saved Google sign-in predates the verification permissions. Press{" "}
        <span className="font-medium text-ink">“Connect another Google account”</span> above and
        sign in with the same account — the connection is upgraded in place, then come back here.
      </p>
    );
  }
  if (status.error) return <p className="text-sm text-critical">{status.error}</p>;

  const done = (status.remaining ?? 0) === 0;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-ink">
        <span className="tnum font-medium">{status.connected}</span> of{" "}
        <span className="tnum font-medium">{status.zones}</span> Cloudflare zones are registered in
        Search Console{done ? " — all connected." : `; ${status.remaining} to go.`}
      </p>
      {!done && (
        <button
          onClick={runBatch}
          disabled={running}
          className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? "Connecting batch…" : "Verify + connect next 20"}
        </button>
      )}
      {log.map((line, i) => (
        <p key={i} className={i === 0 ? "text-ink-2" : "text-muted"}>
          {line}
        </p>
      ))}
      {failures.length > 0 && (
        <div className="text-xs text-critical">
          {failures.map((f) => (
            <p key={f.domain}>
              {f.domain} — {f.step}: {f.error}
            </p>
          ))}
          <p className="mt-1 text-muted">
            Failed domains are retried automatically on the next batch press.
          </p>
        </div>
      )}
    </div>
  );
}
