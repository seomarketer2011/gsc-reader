"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { SideNav } from "./SideNav";

/** Below the md breakpoint the sidebar is hidden entirely, which left phones
 * with no navigation at all — no way to even reach the other screens. This
 * bar restores it: the app title plus a menu button that folds the same
 * SideNav links out underneath. Closes itself after navigating. */
export function MobileNav({ orgName }: { orgName: string }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="border-b border-edge bg-surface md:hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-ink">SEO Opportunity Engine</div>
          <div className="mt-0.5 text-xs text-ink-2">{orgName}</div>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Close navigation menu" : "Open navigation menu"}
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-ink hover:bg-page"
        >
          {open ? "Close ✕" : "Menu ☰"}
        </button>
      </div>
      {open && (
        <div className="border-t border-edge">
          <SideNav />
        </div>
      )}
    </div>
  );
}
