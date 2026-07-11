"use client";

import { ErrorPanel } from "@/components/ui";

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <ErrorPanel
      title="Something went wrong loading this screen"
      message={
        error.message ||
        "An unexpected error occurred. Retry, or return to the Opportunity Inbox."
      }
      onRetry={unstable_retry}
    />
  );
}
