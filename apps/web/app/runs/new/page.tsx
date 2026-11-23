import type { Metadata } from "next";
import { NewTestForm } from "../../../components/NewTestForm";
import { HowItWorks, RecentRuns } from "../../../components/NewTestAside";

export const metadata: Metadata = { title: "New test" };

export default async function NewTestPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; suggestion?: string | string[] }>;
}) {
  const { from, suggestion } = await searchParams;
  return (
    <div className="new-test">
      <div className="new-test-main flex min-w-0 flex-col gap-6">
        <div className="title-block flex min-w-0 flex-col gap-2">
          <p className="eyebrow">New test</p>
          <h1 className="page-title">Create a test</h1>
          <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">
            Describe a flow, review the checks, and get results backed by a real browser.
          </p>
        </div>
        <NewTestForm from={typeof from === "string" ? from : null} suggestion={typeof suggestion === "string" ? suggestion : null} />
      </div>
      <aside className="new-test-aside" aria-label="About test runs">
        <HowItWorks />
        <RecentRuns />
      </aside>
    </div>
  );
}
