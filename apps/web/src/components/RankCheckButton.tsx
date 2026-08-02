"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Drives the queue-based rank check: the first call posts every unchecked
// keyword to DataForSEO's task queue, then the loop collects results as they
// finish. Closing the tab is safe — the server cron keeps collecting.
export function RankCheckButton({ keywordCount }: { keywordCount: number }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);

  async function run() {
    setState("running");
    setMessage("Queuing keywords…");
    cancelled.current = false;
    try {
      for (let i = 0; i < 400; i++) {
        if (cancelled.current) return;
        const res = await fetch("/api/rank-tracker/run", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (data.done) {
          setState("done");
          setMessage(`All ${data.total} keywords checked.`);
          router.refresh();
          return;
        }
        setMessage(
          `${data.checked} of ${data.total} collected · ${data.processing} processing…`,
        );
        // Stream results onto the dashboard as they land.
        if (i % 3 === 2) router.refresh();
        // Results arrive over a few minutes — poll gently, not in a tight loop.
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error(
        "Still processing — safe to close this tab; results keep collecting automatically.",
      );
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "Check failed");
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        onClick={run}
        disabled={state === "running" || keywordCount === 0}
        className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === "running" ? "Checking…" : "Check rankings now"}
      </button>
      {message && (
        <span className={`text-xs ${state === "error" ? "text-critical" : "text-ink-2"}`}>
          {message}
        </span>
      )}
    </span>
  );
}
