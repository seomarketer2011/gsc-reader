"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RunAnalysisButton() {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [message, setMessage] = useState("");

  async function run() {
    setState("running");
    try {
      const res = await fetch("/api/analysis/run", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMessage(`${data.opportunities} opportunities found`);
      setState("idle");
      router.refresh();
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={run}
        disabled={state === "running"}
        className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {state === "running" ? "Analysing…" : "Run analysis"}
      </button>
      {message && (
        <span className={`text-xs ${state === "error" ? "text-critical" : "text-delta-good"}`}>
          {message}
        </span>
      )}
    </span>
  );
}
