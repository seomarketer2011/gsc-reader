"use client";

import { useFormStatus } from "react-dom";

// Submit button that disables itself while its form's server action runs —
// without this, slow responses invite repeat clicks and duplicate rows.
export function PendingButton({
  children,
  pendingLabel = "Saving…",
  className,
  formAction,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={pending}
      className={`${className ?? ""} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
