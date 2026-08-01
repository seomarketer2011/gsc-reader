import Link from "next/link";
import { revalidatePath } from "next/cache";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { Sparkline } from "@/components/charts";
import { getScopedSiteIds, getSiteDailySeries, getSites } from "@/lib/data";
import {
  getRealDailySeries,
  getRealGroups,
  getRealScopeSiteIds,
  getRealSites,
  RealGroup,
  RealSite,
} from "@/lib/data/real";
import { getServerClient } from "@/lib/supabase/server";
import { PendingButton } from "@/components/PendingButton";
import { formatInt, parseScope } from "@/lib/format";

async function callerOrgId() {
  const supabase = await getServerClient();
  if (!supabase) return null;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return null;
  const { data: membership } = await supabase
    .from("organisation_users")
    .select("organisation_id")
    .eq("user_id", userData.user.id)
    .limit(1)
    .maybeSingle();
  return membership ? { supabase, orgId: membership.organisation_id as string } : null;
}

async function createGroup(formData: FormData) {
  "use server";
  const caller = await callerOrgId();
  const name = String(formData.get("name") ?? "").trim();
  const siteIds = formData.getAll("site").map(String);
  if (!caller || !name) return;
  // Idempotent by name: repeat submissions (double clicks, Enter-key repeats,
  // pre-hydration replays) update the existing group instead of duplicating it.
  const { data: existing } = await caller.supabase
    .from("campaigns")
    .select("id")
    .eq("organisation_id", caller.orgId)
    .eq("name", name)
    .limit(1)
    .maybeSingle();
  let groupId = existing?.id as string | undefined;
  if (!groupId) {
    const { data: group } = await caller.supabase
      .from("campaigns")
      .insert({ organisation_id: caller.orgId, name })
      .select("id")
      .single();
    groupId = group?.id as string | undefined;
  }
  if (groupId) {
    await caller.supabase.from("campaign_sites").delete().eq("campaign_id", groupId);
    if (siteIds.length > 0) {
      await caller.supabase.from("campaign_sites").insert(
        siteIds.map((siteId) => ({
          organisation_id: caller.orgId,
          campaign_id: groupId,
          site_id: siteId,
        })),
      );
    }
  }
  revalidatePath("/", "layout"); // group list feeds the global View selector
}

async function saveGroupMembers(formData: FormData) {
  "use server";
  const caller = await callerOrgId();
  const groupId = String(formData.get("groupId") ?? "");
  const siteIds = formData.getAll("site").map(String);
  if (!caller || !groupId) return;
  // RLS restricts both statements to the caller's organisation.
  await caller.supabase.from("campaign_sites").delete().eq("campaign_id", groupId);
  if (siteIds.length > 0) {
    await caller.supabase.from("campaign_sites").insert(
      siteIds.map((siteId) => ({
        organisation_id: caller.orgId,
        campaign_id: groupId,
        site_id: siteId,
      })),
    );
  }
  revalidatePath("/", "layout");
}

async function deleteGroup(formData: FormData) {
  "use server";
  const caller = await callerOrgId();
  const groupId = String(formData.get("groupId") ?? "");
  if (!caller || !groupId) return;
  await caller.supabase.from("campaigns").delete().eq("id", groupId);
  revalidatePath("/", "layout");
}

function SiteCheckboxes({ sites, checked }: { sites: RealSite[]; checked?: Set<string> }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
      {sites.map((site) => (
        <label key={site.id} className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            name="site"
            value={site.id}
            defaultChecked={checked?.has(site.id) ?? false}
            className="accent-[var(--series-1)]"
          />
          <span className="truncate" title={site.domain}>
            {site.name}
          </span>
        </label>
      ))}
    </div>
  );
}

function GroupManager({ groups, sites }: { groups: RealGroup[]; sites: RealSite[] }) {
  const button =
    "rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90";
  return (
    <div className="mt-6">
      <h2 className="mb-1 text-base font-semibold text-ink">Site groups</h2>
      <p className="mb-3 text-sm text-ink-2">
        Group sites by industry (e.g. locksmiths, electricians) to compare and analyse them
        together. Pick a group in the View selector above to scope every screen to it; the
        analysis run pools content-gap detection within each group only.
      </p>
      <div className="space-y-4">
        {groups.map((group) => (
          <Card key={group.id} className="p-4">
            <form action={saveGroupMembers}>
              <input type="hidden" name="groupId" value={group.id} />
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="text-sm font-medium text-ink">
                  {group.name}
                  <span className="ml-2 text-xs font-normal text-muted">
                    {group.siteIds.length} {group.siteIds.length === 1 ? "site" : "sites"}
                  </span>
                </div>
                <div className="flex gap-2">
                  <PendingButton className={button}>Save members</PendingButton>
                  <PendingButton
                    formAction={deleteGroup}
                    pendingLabel="Working…"
                    className="rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-critical hover:bg-page"
                  >
                    Delete group
                  </PendingButton>
                </div>
              </div>
              <SiteCheckboxes sites={sites} checked={new Set(group.siteIds)} />
            </form>
          </Card>
        ))}
        <Card className="p-4">
          <form action={createGroup}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <input
                name="name"
                required
                placeholder="New group name… e.g. Locksmiths"
                className="w-64 rounded-md border border-edge bg-surface px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-series-1"
                aria-label="Group name"
              />
              <PendingButton className={button} pendingLabel="Creating…">
                Create group
              </PendingButton>
            </div>
            <SiteCheckboxes sites={sites} />
          </form>
        </Card>
      </div>
    </div>
  );
}

export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  // Real Search Console data takes over as soon as a property is tracked.
  const allRealSites = await getRealSites();
  let realSites = allRealSites;
  const scopeRaw = typeof params.scope === "string" ? params.scope : "";
  const scopedIds = await getRealScopeSiteIds(scopeRaw || undefined);
  if (scopedIds) {
    const idSet = new Set(scopedIds);
    realSites = realSites.filter((s) => idSet.has(s.id));
  }
  const rangeDays = Math.min(Number(params.range ?? 28) || 28, 180);
  if (allRealSites.length > 0) {
    const groups = await getRealGroups();
    const rows = await Promise.all(
      realSites.map(async (site) => {
        const series = await getRealDailySeries(site.propertyId, rangeDays * 2);
        const last28 = series.slice(-rangeDays);
        const prev28 = series.slice(0, rangeDays);
        const clicks = last28.reduce((sum, p) => sum + p.clicks, 0);
        const prevClicks = prev28.reduce((sum, p) => sum + p.clicks, 0);
        return {
          site,
          clicks,
          impressions: last28.reduce((sum, p) => sum + p.impressions, 0),
          changePct: prevClicks ? ((clicks - prevClicks) / prevClicks) * 100 : 0,
          spark: last28.map((p) => p.clicks),
        };
      }),
    );
    const sortKey = typeof params.sort === "string" ? params.sort : "clicks";
    const sortDir = params.dir === "asc" ? 1 : -1;
    const rowValue = (r: (typeof rows)[number]): number | string => {
      switch (sortKey) {
        case "name": return r.site.name;
        case "impressions": return r.impressions;
        case "change": return r.changePct;
        default: return r.clicks;
      }
    };
    rows.sort((a, b) => {
      const va = rowValue(a), vb = rowValue(b);
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return cmp * sortDir;
    });
    const sortHref = (key: string) =>
      `/sites?${new URLSearchParams({
        ...(scopeRaw ? { scope: scopeRaw } : {}),
        ...(typeof params.range === "string" ? { range: params.range } : {}),
        sort: key,
        dir: sortKey === key && sortDir === -1 ? "asc" : "desc",
      }).toString()}`;
    const arrow = (key: string) => (sortKey === key ? (sortDir === -1 ? " ▼" : " ▲") : "");
    return (
      <div>
        <PageHeader
          title="Sites"
          subtitle={`${rows.length} tracked ${rows.length === 1 ? "property" : "properties"} · real Search Console data · last ${rangeDays} days`}
        />
        {rows.length === 0 ? (
          <EmptyState
            title="No sites in this scope"
            body="The selected group contains no sites. Add sites to it below, or switch back to all tracked properties."
          />
        ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-edge">
                <th className="px-4 py-2.5 font-medium"><Link href={sortHref("name")} className="hover:text-ink">Site{arrow("name")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("clicks")} className="hover:text-ink">Clicks{arrow("clicks")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("impressions")} className="hover:text-ink">Impressions{arrow("impressions")}</Link></th>
                <th className="px-4 py-2.5 text-right font-medium"><Link href={sortHref("change")} className="hover:text-ink">Δ vs prev{arrow("change")}</Link></th>
                <th className="px-4 py-2.5 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ site, clicks, impressions, changePct, spark }) => (
                <tr key={site.id} className="border-b border-edge last:border-0 hover:bg-page">
                  <td className="px-4 py-2">
                    <Link href={`/sites/${site.id}`} className="font-medium text-ink hover:text-series-1">
                      {site.name}
                    </Link>
                    <div className="text-xs text-muted">{site.propertyUri}</div>
                  </td>
                  <td className="px-4 py-2 text-right text-ink tnum">{formatInt(clicks)}</td>
                  <td className="px-4 py-2 text-right text-ink-2 tnum">{formatInt(impressions)}</td>
                  <td className={`px-4 py-2 text-right font-medium tnum ${changePct >= 0 ? "text-delta-good" : "text-critical"}`}>
                    {changePct >= 0 ? "▲" : "▼"} {Math.abs(changePct).toFixed(1)}%
                  </td>
                  <td className="px-4 py-2">
                    <Sparkline values={spark} label={`${site.name} daily clicks, last 28 days`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        )}
        <p className="mt-3 text-xs text-muted">
          Data imports nightly once scheduling lands (Phase 6); use “Resume / update import” on the
          Connections page to refresh manually until then.
        </p>
        <GroupManager groups={groups} sites={allRealSites} />
      </div>
    );
  }

  const scope = parseScope(typeof params.scope === "string" ? params.scope : undefined);
  const sort = typeof params.sort === "string" ? params.sort : "clicks";
  const [siteIds, allSites] = await Promise.all([getScopedSiteIds(scope), getSites()]);
  const idSet = new Set(siteIds);
  const sites = allSites.filter((s) => idSet.has(s.id));

  const rows = await Promise.all(
    sites.map(async (site) => {
      const series = await getSiteDailySeries(site.id);
      const last28 = series.slice(-28);
      const prev28 = series.slice(-56, -28);
      const clicks = last28.reduce((s, p) => s + p.clicks, 0);
      const prevClicks = prev28.reduce((s, p) => s + p.clicks, 0);
      return {
        site,
        clicks,
        impressions: last28.reduce((s, p) => s + p.impressions, 0),
        changePct: prevClicks ? ((clicks - prevClicks) / prevClicks) * 100 : 0,
        spark: last28.map((p) => p.clicks),
      };
    }),
  );

  rows.sort((a, b) =>
    sort === "change"
      ? b.changePct - a.changePct
      : sort === "name"
        ? a.site.name.localeCompare(b.site.name)
        : b.clicks - a.clicks,
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No sites in this scope"
        body="The selected campaign contains no sites. Choose another campaign or the full network."
      />
    );
  }

  const sortLink = (key: string, label: string) => (
    <Link
      href={`/sites?${new URLSearchParams({ ...(typeof params.scope === "string" ? { scope: params.scope } : {}), sort: key }).toString()}`}
      className={sort === key ? "text-series-1" : "text-ink-2 hover:text-ink"}
    >
      {label}
    </Link>
  );

  return (
    <div>
      <PageHeader title="Sites" subtitle={`${rows.length} sites in scope · last 28 days`} />
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-edge">
              <th className="px-4 py-2.5 font-medium">{sortLink("name", "Site")}</th>
              <th className="px-4 py-2.5 font-medium">Location</th>
              <th className="px-4 py-2.5 text-right font-medium">{sortLink("clicks", "Clicks")}</th>
              <th className="px-4 py-2.5 text-right font-medium">Impressions</th>
              <th className="px-4 py-2.5 text-right font-medium">{sortLink("change", "Δ vs prev")}</th>
              <th className="px-4 py-2.5 font-medium">Trend (28d)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ site, clicks, impressions, changePct, spark }) => (
              <tr key={site.id} className="border-b border-edge last:border-0 hover:bg-page">
                <td className="px-4 py-2">
                  <Link href={`/sites/${site.id}`} className="font-medium text-ink hover:text-series-1">
                    {site.name}
                  </Link>
                  <div className="text-xs text-muted">{site.domain}</div>
                </td>
                <td className="px-4 py-2 text-ink-2">
                  {site.location} · {site.region}
                </td>
                <td className="px-4 py-2 text-right text-ink tnum">{formatInt(clicks)}</td>
                <td className="px-4 py-2 text-right text-ink-2 tnum">{formatInt(impressions)}</td>
                <td
                  className={`px-4 py-2 text-right font-medium tnum ${
                    changePct >= 0 ? "text-delta-good" : "text-critical"
                  }`}
                >
                  {changePct >= 0 ? "▲" : "▼"} {Math.abs(changePct).toFixed(1)}%
                </td>
                <td className="px-4 py-2">
                  <Sparkline values={spark} label={`${site.name} daily clicks, last 28 days`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
