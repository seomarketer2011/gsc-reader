"use server";

import { redirect } from "next/navigation";
import { getServerClient, getServiceClient } from "@/lib/supabase/server";

export async function signOut() {
  const supabase = await getServerClient();
  if (supabase) await supabase.auth.signOut();
  redirect("/login");
}

/**
 * First-login onboarding: every user belongs to an organisation. Membership
 * rows are service-role-only by design (RLS grants members no insert), so
 * this runs server-side with the service key.
 * Returns the user's organisation id, or null when it cannot be resolved.
 */
export async function ensureOrganisation(): Promise<string | null> {
  const supabase = await getServerClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Existing membership? (visible to the member under RLS)
  const { data: membership } = await supabase
    .from("organisation_users")
    .select("organisation_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (membership) return membership.organisation_id;

  const service = getServiceClient();
  if (!service) return null; // no service key in this environment

  const orgName = user.email ? `${user.email.split("@")[0]}'s organisation` : "My organisation";
  const { data: org, error: orgError } = await service
    .from("organisations")
    .insert({ name: orgName })
    .select("id")
    .single();
  if (orgError || !org) return null;

  const { error: memberError } = await service
    .from("organisation_users")
    .insert({ organisation_id: org.id, user_id: user.id, role: "owner" });
  if (memberError) return null;

  await service.from("profiles").upsert({ id: user.id });
  return org.id;
}
