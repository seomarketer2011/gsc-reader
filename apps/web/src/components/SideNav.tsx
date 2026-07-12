"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const ITEMS = [
  { href: "/", label: "Opportunity Inbox", icon: "◉" },
  { href: "/coverage", label: "Coverage matrix", icon: "▦" },
  { href: "/sites", label: "Sites", icon: "⌂" },
  { href: "/clusters", label: "Query clusters", icon: "≣" },
  { href: "/rollouts", label: "Rollouts", icon: "⇶" },
  { href: "/keywords", label: "Keyword research", icon: "⌕" },
  { href: "/connections", label: "Google connections", icon: "⚲" },
];

// Sidebar navigation. Preserves the global scope/date/compare selection when
// moving between screens.
export function SideNav() {
  const pathname = usePathname();
  const params = useSearchParams();
  const kept = new URLSearchParams();
  for (const key of ["scope", "range", "compare"]) {
    const v = params.get(key);
    if (v) kept.set(key, v);
  }
  const suffix = kept.toString() ? `?${kept.toString()}` : "";

  return (
    <nav className="flex flex-col gap-0.5 p-3">
      {ITEMS.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={`${item.href}${suffix}`}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium ${
              active
                ? "bg-page text-series-1"
                : "text-ink-2 hover:bg-page hover:text-ink"
            }`}
          >
            <span aria-hidden className="w-4 text-center">
              {item.icon}
            </span>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
