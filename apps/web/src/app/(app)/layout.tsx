import { Suspense } from "react";
import { redirect } from "next/navigation";
import { GlobalBar } from "@/components/GlobalBar";
import { SideNav } from "@/components/SideNav";
import { AppStateProvider } from "@/components/AppStateProvider";
import { AuthWatcher } from "@/components/AuthWatcher";
import { ensureOrganisation, signOut } from "@/lib/auth/actions";
import { getServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getCampaigns, getNetwork, getOrganisation, getSites } from "@/lib/data";
import { getRealSites } from "@/lib/data/real";
import { Site } from "@/lib/types";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [organisation, ...fixture] = await Promise.all([
    getOrganisation(),
    getNetwork(),
    getCampaigns(),
    getSites(),
  ]);
  let [network, campaigns, sites] = fixture as [
    Awaited<ReturnType<typeof getNetwork>>,
    Awaited<ReturnType<typeof getCampaigns>>,
    Awaited<ReturnType<typeof getSites>>,
  ];
  // Real mode: the global selector lists tracked properties, not demo sites.
  const realSites = await getRealSites();
  if (realSites.length > 0) {
    network = { id: "net-real", name: `Tracked properties (${realSites.length})`, siteIds: realSites.map((s) => s.id) };
    campaigns = [];
    sites = realSites.map((s) => ({ id: s.id, name: s.name }) as Site);
  }

  const configured = isSupabaseConfigured();
  let email: string | null = null;
  let userId: string | null = null;
  let orgId: string | null = null;
  if (configured) {
    const supabase = await getServerClient();
    const {
      data: { user },
    } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
    if (!user) redirect("/login");
    email = user.email ?? null;
    userId = user.id;
    orgId = await ensureOrganisation();
  }

  return (
    <AppStateProvider value={{ configured, userId, orgId, email }}>
      <AuthWatcher />
      <div className="flex min-h-screen">
        <aside className="hidden w-60 shrink-0 flex-col border-r border-edge bg-surface md:flex">
          <div className="border-b border-edge px-4 py-3.5">
            <div className="text-sm font-semibold text-ink">SEO Opportunity Engine</div>
            <div className="mt-0.5 text-xs text-ink-2">{organisation.name}</div>
          </div>
          <Suspense>
            <SideNav />
          </Suspense>
          <div className="mt-auto border-t border-edge px-4 py-3 text-xs">
            {email ? (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink-2" title={email}>
                  {email}
                </span>
                <form action={signOut}>
                  <button className="font-medium text-muted hover:text-ink">Sign out</button>
                </form>
              </div>
            ) : (
              <span className="text-muted">
                {configured ? "Not signed in" : "Fixture mode — Supabase not configured"}
              </span>
            )}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense>
            <GlobalBar network={network} campaigns={campaigns} sites={sites} />
          </Suspense>
          <main className="flex-1 p-4 md:p-6">{children}</main>
        </div>
      </div>
    </AppStateProvider>
  );
}
