import type { Metadata } from "next";
import { NewTestForm } from "../../../components/NewTestForm";

export const metadata: Metadata = { title: "New test" };

export default async function NewTestPage({ searchParams }: { searchParams: Promise<{ from?: string | string[] }> }) {
  const { from } = await searchParams;
  return (
    <div className="narrow stack">
      <div className="section-head">
        <h1>New test</h1>
        <p className="muted">
          Point the platform at a website and describe what should work. It proposes acceptance criteria for you to confirm, explores
          the site, and reports each criterion with its evidence.
        </p>
      </div>
      <NewTestForm from={typeof from === "string" ? from : null} />
    </div>
  );
}
