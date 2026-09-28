import { NextRequest, NextResponse } from "next/server";
import {
  addSearchConsoleDomain,
  decryptToken,
  getDnsVerificationToken,
  GoogleScopeError,
  listProperties,
  refreshAccessToken,
  verifyDnsDomain,
} from "@/lib/google/oauth";
import { cloudflareConfigured, listZones } from "@/lib/cloudflare/zones";
import { ensureApexTxtRecord } from "@/lib/cloudflare/zones";
import { getServerClient } from "@/lib/supabase/server";

export const maxDuration = 300;

// Connects the network's Cloudflare zones to Search Console, one batch per
// POST: for each zone not yet registered, fetch a DNS verification token,
// write the TXT record via the Cloudflare API, ask Google to verify, and
// register the sc-domain: property. Everything is idempotent — re-running a
// domain that half-completed just finishes it. GET reports progress without
// changing anything. Nothing here runs on a schedule; every batch is a
// button press.
const BATCH = 20;

interface Caller {
  accessToken: string;
}

async function caller(): Promise<Caller | { error: string; status: number }> {
  const supabase = await getServerClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  if (!user) return { error: "unauthenticated", status: 401 };
  // RLS scopes connections to the caller's organisations.
  const { data: connections } = await supabase!
    .from("google_connections")
    .select("id, refresh_token_encrypted, status")
    .eq("status", "active")
    .order("created_at");
  const conn = (connections ?? []).find((c) => c.refresh_token_encrypted);
  if (!conn) return { error: "no active Google connection", status: 400 };
  try {
    const accessToken = await refreshAccessToken(await decryptToken(conn.refresh_token_encrypted as string));
    return { accessToken };
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 200) : "token refresh failed", status: 502 };
  }
}

/** Zones not yet registered as sc-domain properties, plus counts. */
async function progress(accessToken: string) {
  const [zones, properties] = await Promise.all([listZones(), listProperties(accessToken)]);
  const inGsc = new Set(
    properties
      .filter((p) => p.siteUrl.startsWith("sc-domain:"))
      .map((p) => p.siteUrl.slice("sc-domain:".length).toLowerCase()),
  );
  const pending = zones.filter((z) => !inGsc.has(z.name.toLowerCase()));
  return { zones, inGsc, pending };
}

export async function GET() {
  if (!cloudflareConfigured()) {
    return NextResponse.json({ error: "Cloudflare API credentials are not configured on the server" }, { status: 500 });
  }
  const c = await caller();
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });
  try {
    const { zones, pending } = await progress(c.accessToken);
    return NextResponse.json({
      zones: zones.length,
      connected: zones.length - pending.length,
      remaining: pending.length,
    });
  } catch (e) {
    if (e instanceof GoogleScopeError) return NextResponse.json({ needsReauth: true, error: e.message }, { status: 403 });
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 300) : "failed" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  if (!cloudflareConfigured()) {
    return NextResponse.json({ error: "Cloudflare API credentials are not configured on the server" }, { status: 500 });
  }
  const c = await caller();
  if ("error" in c) return NextResponse.json({ error: c.error }, { status: c.status });

  const body = (await request.json().catch(() => ({}))) as { batch?: number };
  const batchSize = Math.min(Math.max(Number(body.batch) || BATCH, 1), 50);

  let pending;
  try {
    ({ pending } = await progress(c.accessToken));
  } catch (e) {
    if (e instanceof GoogleScopeError) return NextResponse.json({ needsReauth: true, error: e.message }, { status: 403 });
    return NextResponse.json({ error: e instanceof Error ? e.message.slice(0, 300) : "failed" }, { status: 502 });
  }

  const batch = pending.slice(0, batchSize);
  const connected: string[] = [];
  const failed: { domain: string; step: string; error: string }[] = [];

  for (const zone of batch) {
    let step = "verification token";
    try {
      const token = await getDnsVerificationToken(c.accessToken, zone.name);
      step = "DNS record";
      await ensureApexTxtRecord(zone.id, zone.name, token);
      step = "verify";
      // Cloudflare answers authoritatively as soon as the record is written,
      // but give Google a couple of chances in case its resolver lags.
      let verified = false;
      for (let attempt = 0; attempt < 3 && !verified; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
        try {
          await verifyDnsDomain(c.accessToken, zone.name);
          verified = true;
        } catch (e) {
          if (e instanceof GoogleScopeError || attempt === 2) throw e;
        }
      }
      step = "register property";
      await addSearchConsoleDomain(c.accessToken, zone.name);
      connected.push(zone.name);
    } catch (e) {
      if (e instanceof GoogleScopeError) {
        return NextResponse.json(
          { needsReauth: true, error: e.message, connected, failed },
          { status: 403 },
        );
      }
      failed.push({ domain: zone.name, step, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    }
  }

  return NextResponse.json({
    connected,
    failed,
    remaining: pending.length - batch.length + failed.length,
  });
}
