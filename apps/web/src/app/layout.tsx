import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SEO Opportunity Engine",
  description:
    "Network-wide Search Console opportunity analysis — Phase 2: Supabase-backed workspace.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
