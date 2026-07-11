import { Level } from "@/lib/types";
import { LEVEL_LABEL } from "@/lib/format";
import Link from "next/link";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-edge bg-surface ${className}`}>
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "blue" | "good" | "warning" | "critical";
}) {
  const tones: Record<string, string> = {
    neutral: "border-edge text-ink-2",
    blue: "border-series-1/40 text-series-1",
    good: "border-good/40 text-delta-good",
    warning: "border-warning/50 text-ink-2",
    critical: "border-critical/40 text-critical",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function LevelBadge({ label, level }: { label: string; level: Level }) {
  const tone = level === "high" ? "good" : level === "medium" ? "warning" : "neutral";
  return (
    <Badge tone={tone}>
      {label}: {LEVEL_LABEL[level]}
    </Badge>
  );
}

export function StatTile({
  label,
  value,
  detail,
  delta,
}: {
  label: string;
  value: string;
  detail?: string;
  delta?: number;
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-ink">{value}</div>
      {delta !== undefined && (
        <div className={`text-xs font-medium ${delta >= 0 ? "text-delta-good" : "text-critical"}`}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}% vs previous period
        </div>
      )}
      {detail && <div className="mt-0.5 text-xs text-ink-2">{detail}</div>}
    </Card>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <Card className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <div className="text-base font-semibold text-ink">{title}</div>
      <p className="max-w-md text-sm text-ink-2">{body}</p>
      {action && (
        <Link
          href={action.href}
          className="mt-2 rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-series-1 hover:bg-page"
        >
          {action.label}
        </Link>
      )}
    </Card>
  );
}

export function ErrorPanel({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Card className="flex flex-col items-center gap-2 border-critical/40 px-6 py-14 text-center">
      <div className="text-base font-semibold text-critical">⚠ {title}</div>
      <p className="max-w-md text-sm text-ink-2">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-2 rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-ink hover:bg-page"
        >
          Try again
        </button>
      )}
    </Card>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-grid ${className}`} />;
}

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
