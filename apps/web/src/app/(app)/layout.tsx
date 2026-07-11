import { Suspense } from "react";
import { GlobalBar } from "@/components/GlobalBar";
import { SideNav } from "@/components/SideNav";
import { AppStateProvider } from "@/components/AppStateProvider";
import { ensureOrganisation, signOut } from "@/lib/auth/actions";
import { getServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getCampaigns, getNetwork, getOrganisation, getSites } from "@/lib/data";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [organisation, network, campaigns, sites] = await Promise.all([
    getOrganisation(),
    getNetwork(),
    getCampaigns(),
    getSites(),
  ]);

  const configured = isSupabaseConfigured();
  let email: string | null = null;
  let userId: string | null = null;
  let orgId: string | null = null;
  if (configured) {
    const supabase = await getServerClient();
    const {
      data: { user },
    } = (await supabase?.auth.getUser()) ?? { data: { user: null } };
    if (user) {
      email = user.email ?? null;
      userId = user.id;
      orgId = await ensureOrganisation();
    }
  }

  return (
    <AppStateProvider value={{ configured, userId, orgId, email }}>
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
