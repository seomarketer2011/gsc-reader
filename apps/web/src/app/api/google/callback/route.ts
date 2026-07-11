import { NextRequest, NextResponse } from "next/server";
import { emailFromIdToken, encryptToken, exchangeCode } from "@/lib/google/oauth";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

// Google redirects here after consent. Exchanges the code, encrypts the
// refresh token and stores the connection for the user's organisation.
export async function GET(request: NextRequest) {
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/connections?error=${encodeURIComponent(reason)}`, request.url));

  const supabase = await getServerClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return fail(params.get("error")!);
  const code = params.get("code");
  const state = params.get("state");
  const expectedState = request.cookies.get("google_oauth_state")?.value;
  if (!code || !state || !expectedState || state !== expectedState) return fail("state_mismatch");

  let tokens;
  try {
    tokens = await exchangeCode(request.nextUrl.origin, code);
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 200) : "token_exchange_failed");
  }
  if (!tokens.refresh_token) return fail("no_refresh_token");

  // Membership lookup under RLS; insert via service role (RLS is deny-by-
  // default for connections created before any membership exists client-side).
  const { data: membership } = await supabase!
    .from("organisation_users")
    .select("organisation_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (!membership) return fail("no_organisation");

  const service = getServiceClient();
  if (!service) return fail("service_key_missing");

  const email = tokens.id_token ? (emailFromIdToken(tokens.id_token) ?? "unknown") : "unknown";
  const encrypted = await encryptToken(tokens.refresh_token);

  // One connection per Google account per organisation — reconnecting updates it.
  const { data: existing } = await service
    .from("google_connections")
    .select("id")
    .eq("organisation_id", membership.organisation_id)
    .eq("google_account_email", email)
    .maybeSingle();

  const row = {
    organisation_id: membership.organisation_id,
    google_account_email: email,
    refresh_token_encrypted: encrypted,
    status: "active" as const,
  };
  const { error } = existing
    ? await service.from("google_connections").update(row).eq("id", existing.id)
    : await service.from("google_connections").insert(row);
  if (error) return fail(error.message.slice(0, 200));

  const response = NextResponse.redirect(new URL("/connections?connected=1", request.url));
  response.cookies.delete("google_oauth_state");
  return response;
}
