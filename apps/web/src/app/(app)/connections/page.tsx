import Link from "next/link";
import { revalidatePath } from "next/cache";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { decryptToken, googleConfigured, GscProperty, listProperties, refreshAccessToken } from "@/lib/google/oauth";
import { getServerClient } from "@/lib/supabase/server";
import { hasImportedData } from "@/lib/data/real";
import { ImportButton } from "@/components/ImportButton";

export const dynamic = "force-dynamic";

interface ConnectionRow {
  id: string;
  organisation_id: string;
  google_account_email: string;
  refresh_token_encrypted: string | null;
  status: string;
}

async function trackProperty(formData: FormData) {
  "use server";
  const supabase = await getServerClient();
  if (!supabase) return;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return;

  const orgId = String(formData.get("orgId"));
  const propertyUri = String(formData.get("siteUrl"));
  const domain = propertyUri
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  // RLS enforces that the caller is a member of orgId.
  const { data: property, error } = await supabase
    .from("gsc_properties")
    .upsert(
      {
        organisation_id: orgId,
        google_connection_id: String(formData.get("connectionId")),
        property_uri: propertyUri,
        property_type: propertyUri.startsWith("sc-domain:") ? "domain" : "url_prefix",
        permission_level: String(formData.get("permission")),
      },
      { onConflict: "organisation_id,property_uri" },
    )
    .select("id")
    .single();
  if (error || !property) return;

  await supabase.from("sites").upsert(
    { organisation_id: orgId, gsc_property_id: property.id, name: domain, domain },
    { onConflict: "organisation_id,domain" },
  );
  revalidatePath("/connections");
}

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const supabase = await getServerClient();

  if (!supabase) {
    return (
      <EmptyState
        title="Supabase is not configured"
        body="Connecting Google requires the database. Configure Supabase first (see .env.example)."
      />
    );
  }

  const { data: connections } = await supabase
    .from("google_connections")
    .select("id, organisation_id, google_account_email, refresh_token_encrypted, status")
    .order("created_at");
  const { data: tracked } = await supabase.from("gsc_properties").select("id, property_uri");
  const trackedByUri = new Map((tracked ?? []).map((t) => [t.property_uri as string, t.id as string]));
  const importedByProperty = new Map<string, boolean>();
  for (const t of tracked ?? []) importedByProperty.set(t.id as string, await hasImportedData(t.id as string));

  // Live property list per active connection.
  const propertiesByConnection = new Map<string, GscProperty[] | { error: string }>();
  for (const conn of (connections ?? []) as ConnectionRow[]) {
    if (conn.status !== "active" || !conn.refresh_token_encrypted) continue;
    try {
      const accessToken = await refreshAccessToken(await decryptToken(conn.refresh_token_encrypted));
      propertiesByConnection.set(conn.id, await listProperties(accessToken));
    } catch (e) {
      propertiesByConnection.set(conn.id, { error: e instanceof Error ? e.message : "failed" });
    }
  }

  return (
    <div>
      <PageHeader
        title="Google connections"
        subtitle="Read-only access to Search Console. You sign in with Google directly — this app never sees your password."
      >
        <Link
          href="/api/google/start"
          className="rounded-md bg-series-1 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          {connections?.length ? "Connect another Google account" : "Connect Google Search Console"}
        </Link>
      </PageHeader>

      {typeof params.error === "string" && (
        <Card className="mb-4 border-critical/40 p-3 text-sm text-critical">
          Connection failed: {params.error}
        </Card>
      )}
      {params.connected === "1" && (
        <Card className="mb-4 border-good/40 p-3 text-sm text-delta-good">
          Google account connected. Choose the properties to track below.
        </Card>
      )}
      {!googleConfigured() && (
        <Card className="mb-4 p-3 text-sm text-ink-2">
          Google OAuth credentials are not configured in this environment
          (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET).
        </Card>
      )}

      {(connections ?? []).length === 0 ? (
        <EmptyState
          title="No Google account connected yet"
          body="Press “Connect Google Search Console”, sign in with the Google account that owns your Search Console properties, and approve read-only access. Your sites will appear here to select."
        />
      ) : (
        <div className="space-y-4">
          {(connections as ConnectionRow[]).map((conn) => {
            const props = propertiesByConnection.get(conn.id);
            return (
              <Card key={conn.id}>
                <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
                  <div className="text-sm font-medium text-ink">{conn.google_account_email}</div>
                  <Badge tone={conn.status === "active" ? "good" : "critical"}>{conn.status}</Badge>
                </div>
                {!props ? (
                  <p className="px-4 py-4 text-sm text-ink-2">Connection inactive.</p>
                ) : "error" in props ? (
                  <p className="px-4 py-4 text-sm text-critical">
                    Could not list properties: {props.error.slice(0, 300)}
                  </p>
                ) : props.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-ink-2">
                    This Google account has no Search Console properties.
                  </p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-muted">
                      <tr className="border-b border-edge">
                        <th className="px-4 py-2 font-medium">Property</th>
                        <th className="px-4 py-2 font-medium">Permission</th>
                        <th className="px-4 py-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {props.map((p) => (
                        <tr key={p.siteUrl} className="border-b border-edge last:border-0">
                          <td className="px-4 py-2 text-ink">{p.siteUrl}</td>
                          <td className="px-4 py-2 text-ink-2">{p.permissionLevel}</td>
                          <td className="px-4 py-2 text-right">
                            {trackedByUri.has(p.siteUrl) ? (
                              <span className="inline-flex items-center gap-2">
                                <Badge tone="good">tracked</Badge>
                                <ImportButton
                                  propertyId={trackedByUri.get(p.siteUrl)!}
                                  alreadyImported={importedByProperty.get(trackedByUri.get(p.siteUrl)!) ?? false}
                                />
                              </span>
                            ) : (
                              <form action={trackProperty} className="inline">
                                <input type="hidden" name="orgId" value={conn.organisation_id} />
                                <input type="hidden" name="connectionId" value={conn.id} />
                                <input type="hidden" name="siteUrl" value={p.siteUrl} />
                                <input type="hidden" name="permission" value={p.permissionLevel} />
                                <button className="rounded-md border border-edge px-2.5 py-1 font-medium text-series-1 hover:bg-page">
                                  Track this property
                                </button>
                              </form>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
