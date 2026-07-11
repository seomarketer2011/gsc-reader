import { PageHeader } from "@/components/ui";
import { RolloutListClient } from "@/components/RolloutListClient";
import { getSites } from "@/lib/data";

export default async function RolloutsPage() {
  const sites = await getSites();
  const sitesById = Object.fromEntries(sites.map((s) => [s.id, { name: s.name }]));

  return (
    <div>
      <PageHeader
        title="Rollouts"
        subtitle="Page blueprints being applied across the network, in batches."
      />
      <RolloutListClient sitesById={sitesById} />
    </div>
  );
}
