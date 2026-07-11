import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { GlobalBar } from "@/components/GlobalBar";
import { SideNav } from "@/components/SideNav";
import { getCampaigns, getNetwork, getOrganisation, getSites } from "@/lib/data";

export const metadata: Metadata = {
  title: "SEO Opportunity Engine",
  description:
    "Network-wide Search Console opportunity analysis — Phase 1 application shell on fixture data.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [organisation, network, campaigns, sites] = await Promise.all([
    getOrganisation(),
    getNetwork(),
    getCampaigns(),
    getSites(),
  ]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-edge bg-surface md:flex">
          <div className="border-b border-edge px-4 py-3.5">
            <div className="text-sm font-semibold text-ink">SEO Opportunity Engine</div>
            <div className="mt-0.5 text-xs text-ink-2">{organisation.name}</div>
          </div>
          <Suspense>
            <SideNav />
          </Suspense>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense>
            <GlobalBar network={network} campaigns={campaigns} sites={sites} />
          </Suspense>
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
