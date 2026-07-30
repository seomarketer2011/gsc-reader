// Google OAuth for Search Console — server-only helpers.
// Read-only scope; refresh tokens are AES-256-GCM encrypted with
// TOKEN_ENCRYPTION_KEY before they touch the database (docs/PRODUCT_SPEC.md).

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

export function buildAuthUrl(origin: string, state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
    redirect_uri: `${origin}/api/google/callback`,
    response_type: "code",
    scope: `openid email ${GSC_SCOPE}`,
    access_type: "offline",
    prompt: "consent", // always mint a refresh token
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

export async function exchangeCode(origin: string, code: string): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      redirect_uri: `${origin}/api/google/callback`,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export class TokenRefreshError extends Error {
  /**
   * Google returns invalid_grant when the refresh token itself is dead —
   * access revoked in the Google account, password changed, or the token
   * expired (OAuth apps in "Testing" status get 7-day tokens). The only
   * remedy is reconnecting; retrying is pointless.
   */
  readonly invalidGrant: boolean;

  constructor(status: number, body: string) {
    super(`Token refresh failed (${status}): ${body}`);
    this.invalidGrant = body.includes("invalid_grant");
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID!,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new TokenRefreshError(res.status, await res.text());
  const data = (await res.json()) as TokenResponse;
  return data.access_token;
}

/** Email claim from Google's id_token (delivered directly over TLS). */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"),
    );
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

// ── Token encryption (AES-256-GCM, WebCrypto — works on Node and Workers) ──

async function encryptionKey(): Promise<CryptoKey> {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(plain: string): Promise<string> {
  const key = await encryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return Buffer.concat([iv, new Uint8Array(cipher)]).toString("base64");
}

export async function decryptToken(stored: string): Promise<string> {
  const key = await encryptionKey();
  const bytes = Buffer.from(stored, "base64");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12) },
    key,
    bytes.subarray(12),
  );
  return new TextDecoder().decode(plain);
}

// ── Search Console API ─────────────────────────────────────────────────────

export interface GscProperty {
  siteUrl: string;
  permissionLevel: string;
}

export async function listProperties(accessToken: string): Promise<GscProperty[]> {
  const res = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Search Console sites.list failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { siteEntry?: { siteUrl: string; permissionLevel: string }[] };
  return (data.siteEntry ?? []).map((s) => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
}
