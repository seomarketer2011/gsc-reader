import { EmptyState } from "@/components/ui";

export default function NotFound() {
  return (
    <EmptyState
      title="Not found"
      body="This site, cluster or opportunity does not exist in the current dataset. It may have been removed in a newer analysis run."
      action={{ href: "/", label: "Back to the Opportunity Inbox" }}
    />
  );
}
