"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Drives the chunked rank check: keeps calling /api/rank-tracker/run until
// every keyword has today's SERP, then refreshes the dashboard.
export function RankCheckButton({ keywordCount }: { keywordCount: number }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);

  async function run() {
    setState("running");
    setMessage("Starting…");
    cancelled.current = false;
    try {
      for (let i = 0; i < 600; i++) {
        if (cancelled.current) return;
        const res = await fetch("/api/rank-tracker/run", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setMessage(
          `${data.checked} of ${data.total} keywords checked…` +
            (data.errors?.length ? ` (${data.errors[0]})` : ""),
        );
        if (data.done) {
          setState("done");
          setMessage(`All ${data.total} keywords checked.`);
          router.refresh();
          return;
        }
      }
      throw new Error("Run is taking unusually long — press the button to continue.");
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
