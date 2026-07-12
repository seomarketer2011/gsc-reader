"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Drives the chunked backfill: keeps calling /api/google/import until done.
export function ImportButton({ propertyId, alreadyImported }: { propertyId: string; alreadyImported: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);

  async function run() {
    setState("running");
    cancelled.current = false;
    try {
      for (let i = 0; i < 100; i++) {
        if (cancelled.current) return;
        const res = await fetch("/api/google/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setMessage(`${data.importedDays} of ${data.totalDays} days imported…`);
        if (data.done) {
          setState("done");
          setMessage("Import complete.");
          router.refresh();
          return;
        }
      }
      throw new Error("Import is taking unusually long — press the button to continue.");
    } catch (e) {
      setState("error");
      setMessage(e instanceof Error ? e.message : "Import failed");
    }
  }

  if (state === "done") return <span className="text-sm font-medium text-delta-good">{message}</span>;

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={run}
        disabled={state === "running"}
        className="rounded-md border border-edge px-2.5 py-1 text-sm font-medium text-series-1 hover:bg-page disabled:opacity-50"
      >
        {state === "running" ? "Importing…" : alreadyImported ? "Resume / update import" : "Import 16 months"}
      </button>
      {message && (
        <span className={`text-xs ${state === "error" ? "text-critical" : "text-ink-2"}`}>{message}</span>
      )}
    </span>
  );
}
