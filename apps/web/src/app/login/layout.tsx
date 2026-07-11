import { redirect } from "next/navigation";
import { getServerClient } from "@/lib/supabase/server";

// Signed-in users have no business on /login — send them to the Inbox.
export default async function LoginLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const supabase = await getServerClient();
  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) redirect("/");
  }
  return <>{children}</>;
}
