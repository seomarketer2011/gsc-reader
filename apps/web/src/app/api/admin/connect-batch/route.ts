import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase/server";
import {
  decryptToken,
  refreshAccessToken,
  listProperties,
  getDnsVerificationToken,
  verifyDnsDomain,
  addSearchConsoleDomain,
  GoogleScopeError,
} from "@/lib/google/oauth";
import { cloudflareConfigured, listZones } from "@/lib/cloudflare/zones";
import { ensureApexTxtRecord } from "@/lib/cloudflare/zones";

export const maxDuration = 300;

// Curated-batch variant of the network-connect flow: lists pending zones
// (GET) and connects an explicit domain list (POST {domains}), so a sample
// can be chosen offline (random spread, population tiers) instead of taking
// the front of the alphabetical queue. Same token → TXT → verify → register
// steps as /api/google/network-connect. Guarded by the ANALYSIS_SECRET
// Worker secret, which is only set for the duration of a session and
// deleted after — without it every request gets 403 and the route is inert.

async function accessToken(): Promise<string | { error: string; status: number }> {
  const s = getServiceClient();
  if (!s) return { error: "service key missing", status: 500 };
  const { data: connections, error } = await s
    .from("google_connections")
    .select("id, refresh_token_encrypted, status")
    .eq("status", "active")
    .order("created_at");
  if (error) return { error: error.message, status: 500 };
  const conn = (connections ?? []).find((c) => c.refresh_token_encrypted);
  if (!conn) return { error: "no active Google connection", status: 400 };
  try {
    return await refreshAccessToken(await decryptToken(conn.refresh_token_encrypted as string));
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 300) : "token refresh failed", status: 502 };
  }
}

function guard(request: NextRequest): NextResponse | null {
  const secret = process.env.ANALYSIS_SECRET;
  if (!secret || request.headers.get("x-analysis-secret") !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!cloudflareConfigured()) {
    return NextResponse.json({ error: "Cloudflare credentials missing" }, { status: 500 });
  }
  return null;
}

export async function GET(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  const token = await accessToken();
  if (typeof token !== "string") return NextResponse.json({ error: token.error }, { status: token.status });

  const [zones, properties] = await Promise.all([listZones(), listProperties(token)]);
  const inGsc = new Set(
    properties
      .filter((p) => p.siteUrl.startsWith("sc-domain:"))
      .map((p) => p.siteUrl.slice("sc-domain:".length).toLowerCase()),
  );
  const pending = zones.filter((z) => !inGsc.has(z.name.toLowerCase())).map((z) => z.name).sort();
  const connected = zones.filter((z) => inGsc.has(z.name.toLowerCase())).map((z) => z.name).sort();
  return NextResponse.json({ zones: zones.length, connected, pending });
}

export async function POST(request: NextRequest) {
  const denied = guard(request);
  if (denied) return denied;
  const token = await accessToken();
  if (typeof token !== "string") return NextResponse.json({ error: token.error }, { status: token.status });

  const body = (await request.json().catch(() => ({}))) as { domains?: string[] };
  const wanted = new Set((body.domains ?? []).map((d) => d.toLowerCase()).slice(0, 25));
  if (wanted.size === 0) return NextResponse.json({ error: "no domains given" }, { status: 400 });

  const zones = await listZones();
  const batch = zones.filter((z) => wanted.has(z.name.toLowerCase()));
  const missing = [...wanted].filter((d) => !batch.some((z) => z.name.toLowerCase() === d));

  const connected: string[] = [];
  const failed: { domain: string; step: string; error: string }[] = [];
  const verifyLagged: string[] = [];

  for (const zone of batch) {
    let step = "verification token";
    try {
      const t = await getDnsVerificationToken(token, zone.name);
      step = "DNS record";
      await ensureApexTxtRecord(zone.id, zone.name, t);
      step = "verify";
      let verified = false;
      for (let attempt = 0; attempt < 3 && !verified; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
        try {
          await verifyDnsDomain(token, zone.name);
          verified = true;
        } catch (e) {
          if (e instanceof GoogleScopeError) throw e;
          if (attempt === 2) verifyLagged.push(zone.name);
        }
      }
      if (!verified) continue;
      step = "register property";
      await addSearchConsoleDomain(token, zone.name);
      connected.push(zone.name);
    } catch (e) {
      if (e instanceof GoogleScopeError) {
        return NextResponse.json({ needsReauth: true, error: e.message, connected, failed }, { status: 403 });
      }
      failed.push({ domain: zone.name, step, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    }
  }

  for (const domain of verifyLagged) {
    let step = "verify (retry)";
    try {
      await new Promise((r) => setTimeout(r, 2000));
      await verifyDnsDomain(token, domain);
      step = "register property";
      await addSearchConsoleDomain(token, domain);
      connected.push(domain);
    } catch (e) {
      if (e instanceof GoogleScopeError) {
        return NextResponse.json({ needsReauth: true, error: e.message, connected, failed }, { status: 403 });
      }
      failed.push({ domain, step, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    }
  }

  return NextResponse.json({ connected, failed, missing });
}
