import { Skeleton } from "@/components/ui";

export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading clusters">
      <Skeleton className="mb-2 h-7 w-52" />
      <Skeleton className="mb-6 h-4 w-96" />
      <Skeleton className="h-[60vh]" />
    </div>
  );
}
