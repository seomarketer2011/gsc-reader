// Cloudflare DNS — server-only helpers for the network-connect flow.
// Uses the account's Global API Key (CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY
// Worker secrets); zones are scoped to CLOUDFLARE_ACCOUNT_ID so a key with
// access to more than one account still only sees the network's zones.

const API = "https://api.cloudflare.com/client/v4";

export interface CfZone {
  id: string;
  name: string;
  status: string;
}

export function cloudflareConfigured(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_EMAIL &&
      process.env.CLOUDFLARE_API_KEY &&
      process.env.CLOUDFLARE_ACCOUNT_ID,
  );
}

function headers(): Record<string, string> {
  return {
    "X-Auth-Email": process.env.CLOUDFLARE_EMAIL!,
    "X-Auth-Key": process.env.CLOUDFLARE_API_KEY!,
    "Content-Type": "application/json",
  };
}

async function cfJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  const data = (await res.json()) as {
    success: boolean;
    errors?: { message: string }[];
    result: T;
    result_info?: { page: number; total_pages: number };
  };
  if (!res.ok || !data.success) {
    throw new Error(
      `Cloudflare API ${res.status}: ${(data.errors ?? []).map((e) => e.message).join("; ") || "failed"}`,
    );
  }
  return data.result;
}

/** Every active zone on the account, paged. */
export async function listZones(): Promise<CfZone[]> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const zones: CfZone[] = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `${API}/zones?account.id=${account}&status=active&per_page=100&page=${page}`,
      { headers: headers() },
    );
    const data = (await res.json()) as {
      success: boolean;
      errors?: { message: string }[];
      result: CfZone[];
      result_info?: { total_pages: number };
    };
    if (!res.ok || !data.success) {
      throw new Error(
        `Cloudflare zones list ${res.status}: ${(data.errors ?? []).map((e) => e.message).join("; ") || "failed"}`,
      );
    }
    zones.push(...(data.result ?? []).map((z) => ({ id: z.id, name: z.name, status: z.status })));
    if (!data.result_info || page >= data.result_info.total_pages) break;
  }
  return zones;
}

/** Ensures a TXT record with this content exists at the zone apex.
 * Idempotent: re-running never duplicates the record. */
export async function ensureApexTxtRecord(zoneId: string, zoneName: string, content: string): Promise<void> {
  const existing = await cfJson<{ id: string; content: string }[]>(
    `${API}/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(zoneName)}&per_page=100`,
  );
  // Cloudflare may return TXT content with or without surrounding quotes.
  const wanted = content.replace(/^"|"$/g, "");
  if (existing.some((r) => r.content.replace(/^"|"$/g, "") === wanted)) return;
  await cfJson(`${API}/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "TXT", name: "@", content, ttl: 300 }),
  });
}
