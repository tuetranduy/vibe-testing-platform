import type { Metadata } from "next";
import { NewTestForm } from "../../../components/NewTestForm";
import { HowItWorks, RecentRuns } from "../../../components/NewTestAside";

export const metadata: Metadata = { title: "New test" };

export default async function NewTestPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await searchParams;
  return (
    <div className="new-test">
      <div className="new-test-main">
        <div className="title-block">
          <p className="eyebrow">New test</p>
          <h1 className="page-title">What should work?</h1>
          <p className="page-lede">
            Give a website and describe the behaviour in plain language. You&apos;ll confirm the acceptance criteria before anything
            runs, then get a report with the evidence for each one.
          </p>
        </div>
        <NewTestForm from={typeof from === "string" ? from : null} />
      </div>
      <aside className="new-test-aside" aria-label="About test runs">
        <HowItWorks />
        <RecentRuns />
      </aside>
    </div>
  );
}
