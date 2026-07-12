import { notFound } from "next/navigation";
import { EmptyState, PageHeader } from "@/components/ui";
import { RolloutBuilderClient } from "@/components/RolloutBuilderClient";
import { getOpportunity, getSites, NotFoundError } from "@/lib/data";
import { getRealOpportunities, getRealSites } from "@/lib/data/real";

export default async function NewRolloutPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const opportunityId = typeof params.opportunity === "string" ? params.opportunity : "";

  if (!opportunityId) {
    return (
      <EmptyState
        title="Pick an opportunity first"
        body="The rollout builder starts from a network opportunity. Choose one in the Opportunity Inbox and press “Create rollout”."
        action={{ href: "/", label: "Open the Opportunity Inbox" }}
      />
    );
  }

  // Real (database) opportunities first, then the fixture world.
  let opportunity = (await getRealOpportunities()).find((o) => o.id === opportunityId) ?? null;
  const isReal = opportunity !== null;
  if (!opportunity) {
    try {
      opportunity = await getOpportunity(opportunityId);
    } catch (e) {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }
  }

  if (opportunity.type !== "missing_dedicated_page") {
    return (
      <EmptyState
        title="Not a network opportunity"
        body="Rollouts apply a page blueprint across many sites, so they can only be built from network page opportunities."
        action={{ href: "/", label: "Back to the Inbox" }}
      />
    );
  }

  const sitesById = isReal
    ? Object.fromEntries(
        (await getRealSites()).map((s) => [
          s.id,
          { id: s.id, name: s.name, domain: s.domain, location: s.domain },
        ]),
      )
    : Object.fromEntries(
        (await getSites()).map((s) => [s.id, { id: s.id, name: s.name, domain: s.domain, location: s.location }]),
      );

  return (
    <div>
      <PageHeader
        title="New page rollout"
        subtitle={opportunity.title}
      />
      <RolloutBuilderClient opportunity={opportunity} sitesById={sitesById} />
    </div>
  );
}
