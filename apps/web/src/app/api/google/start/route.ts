import { NextRequest, NextResponse } from "next/server";
import { buildAuthUrl, googleConfigured } from "@/lib/google/oauth";
import { getServerClient } from "@/lib/supabase/server";

// Begins the Google OAuth flow. Signed-in users only.
export async function GET(request: NextRequest) {
  const supabase = await getServerClient();
  const user = supabase ? (await supabase.auth.getUser()).data.user : null;
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/connections?error=google_not_configured", request.url));
  }

  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const response = NextResponse.redirect(buildAuthUrl(request.nextUrl.origin, state));
  response.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    maxAge: 600,
    path: "/api/google",
  });
  return response;
}
