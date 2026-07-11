import Link from "next/link";

export default function RootNotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-page p-6 text-center">
      <div className="text-base font-semibold text-ink">Page not found</div>
      <p className="max-w-md text-sm text-ink-2">This address does not exist.</p>
      <Link href="/" className="mt-2 text-sm font-medium text-series-1 hover:underline">
        Back to the Opportunity Inbox
      </Link>
    </div>
  );
}
