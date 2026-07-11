import { createServerClient } from "@supabase/ssr";
import { createClient as createBareClient, SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "./config";

/** Cookie-bound server client for the current request, or null in fixture mode. */
export async function getServerClient(): Promise<SupabaseClient | null> {
  if (!isSupabaseConfigured()) return null;
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, which cannot write cookies.
          // Token refresh cookies are written client-side by the browser
          // client (see AuthWatcher), so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * Service-role client — bypasses RLS. Server only; used for onboarding
 * (creating an organisation + membership, which member policies cannot).
 */
export function getServiceClient(): SupabaseClient | null {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!isSupabaseConfigured() || !serviceKey) return null;
  return createBareClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
