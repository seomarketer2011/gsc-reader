import { PageHeader } from "@/components/ui";
import { KeywordResearch } from "@/components/KeywordResearch";

export default function KeywordsPage() {
  return (
    <div>
      <PageHeader
        title="Keyword research"
        subtitle="Standalone volume lookup — not tied to any site or campaign. Volumes, CPC, competition and 12-month trends from DataForSEO, cross-referenced against your own rankings."
      />
      <KeywordResearch />
    </div>
  );
}
