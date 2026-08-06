"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// Drives the queue-based rank check for ONE campaign: the first call posts
// that campaign's unchecked keywords to DataForSEO's task queue, then the
// loop collects results as they finish. Closing the tab is safe — the server
// cron keeps collecting.
//
// Timings are set by how DataForSEO's standard queue actually behaves: most
// tasks come back within a couple of minutes and effectively all of them
// inside 20. Watching stops after WATCH_MINUTES, which is NOT a failure —
// collection carries on server-side either way, so the end of the watch says
// "still going, look at the page" rather than throwing an error at somebody
// whose check is running perfectly well.
const WATCH_MINUTES = 45;
const FAST_POLL_MS = 5000;
const SLOW_POLL_MS = 15000;
const FAST_POLL_FOR_MS = 60000; // tight polling only while results first land

export function RankCheckButton({
  keywordCount,
  campaignId,
  estimatedCost = "",
  depth = 100,
}: {
  keywordCount: number;
  campaignId: string;
  /** Pre-formatted price of a full run, e.g. "$2.86". Shown before starting. */
  estimatedCost?: string;
  /** How far down the results this campaign's checks look. */
  depth?: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "running" | "done" | "background" | "error">("idle");
  const [message, setMessage] = useState("");
  const cancelled = useRef(false);

  useEffect(() => () => void (cancelled.current = true), []);

  async function run() {
    setState("running");
    setMessage("Queuing keywords…");
    cancelled.current = false;
    const startedAt = Date.now();
    try {
      let announcedQueue = false;
      while (Date.now() - startedAt < WATCH_MINUTES * 60000) {
        if (cancelled.current) return;
        const res = await fetch("/api/rank-tracker/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ campaignId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        if (data.done) {
          setState("done");
          setMessage(`All ${data.total} keywords checked.`);
          router.refresh();
          return;
        }
        const elapsed = Math.floor((Date.now() - startedAt) / 60000);
        if (!announcedQueue && data.posted > 0) {
          announcedQueue = true;
          setMessage(
            `${data.posted} keywords queued at DataForSEO — results usually land within 20 minutes.`,
          );
        } else {
          setMessage(
            `${data.checked} of ${data.total} collected · ${data.processing} still processing${
              elapsed > 0 ? ` · ${elapsed} min` : ""
            }…`,
          );
        }
        // Stream results onto the dashboard as they land.
        router.refresh();
        await new Promise((r) =>
          setTimeout(r, Date.now() - startedAt < FAST_POLL_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS),
        );
      }
      // Out of watching time, not out of luck: the cron collects every five
      // minutes whether or not this tab is open.
      setState("background");
      setMessage(
        "Still collecting in the background — safe to close this tab. Refresh the page to see results as they land.",
      );
      router.refresh();
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
      {message ? (
        <span className={`text-xs ${state === "error" ? "text-critical" : "text-ink-2"}`}>
          {message}
        </span>
      ) : (
        estimatedCost &&
        keywordCount > 0 && (
          <span
            className="text-xs text-muted"
            title={`One Google SERP per keyword, read to position ${depth}`}
          >
            ≈{estimatedCost} for {keywordCount} keywords · top {depth}
          </span>
        )
      )}
    </span>
  );
}
