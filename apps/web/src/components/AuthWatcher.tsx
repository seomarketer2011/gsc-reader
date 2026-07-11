"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getBrowserClient } from "@/lib/supabase/client";

// Keeps the Supabase session fresh on the client (the browser client
// auto-refreshes tokens and rewrites the auth cookies) and bounces to /login
// when the session ends. Replaces the Node-runtime proxy, which Cloudflare's
// OpenNext adapter does not support.
export function AuthWatcher() {
  const router = useRouter();

  useEffect(() => {
    const supabase = getBrowserClient();
    if (!supabase) return;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        router.push("/login");
        router.refresh();
      }
    });
    return () => subscription.unsubscribe();
  }, [router]);

  return null;
}
