"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Drives the queue-based rank check for ONE campaign: the first call posts
// that campaign's unchecked keywords to DataForSEO's task queue, then the
// loop collects results as they finish. Closing the tab is safe — the server
// cron keeps collecting.
export function RankCheckButton({
  keywordCount,
  campaignId,
}: {
  keywordCount: number;
  campaignId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);

  async function run() {
    setState("running");
    setMessage("Queuing keywords…");
    cancelled.current = false;
    try {
      let softFailures = 0;
      for (let i = 0; i < 400; i++) {
        if (cancelled.current) return;
        const res = await fetch("/api/rank-tracker/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId }),
        });
        // An empty or non-JSON body (a mid-run server hiccup) is transient:
        // the run itself resumes on the next poll, so ride through it.
        let data: { done?: boolean; checked?: number; total?: number; processing?: number; error?: string; warning?: string } | null = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        if (data === null) {
          if (++softFailures <= 6) {
            setMessage(`Server hiccup (HTTP ${res.status}) — retrying, nothing is lost…`);
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          throw new Error(
            "The server keeps returning unreadable responses. The run is safe — press the button again to resume it.",
          );
        }
        softFailures = 0;
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
