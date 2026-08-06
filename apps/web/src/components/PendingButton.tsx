"use client";

import { useFormStatus } from "react-dom";

// Submit button that disables itself while its form's server action runs —
// without this, slow responses invite repeat clicks and duplicate rows.
//
// confirmMessage makes the button destructive-safe: the form only submits
// after the browser's confirm dialog is accepted. Added after a one-click
// "delete every keyword" wiped a campaign's entire ranking history — anything
// that cascades to data a user spent money collecting must ask first.
export function PendingButton({
  children,
  pendingLabel = "Saving…",
  className,
  formAction,
  confirmMessage,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  confirmMessage?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      formAction={formAction}
      disabled={pending}
      onClick={(e) => {
        if (confirmMessage && !window.confirm(confirmMessage)) e.preventDefault();
      }}
      className={`${className ?? ""} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
