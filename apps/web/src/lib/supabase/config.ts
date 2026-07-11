// Supabase is optional in Phase 2: when the env vars are absent the app runs
// exactly as in Phase 1 — fixture data, no login, browser-local state. This
// keeps local dev, CI and the test harness working without credentials.

export const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
export const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey);
}
