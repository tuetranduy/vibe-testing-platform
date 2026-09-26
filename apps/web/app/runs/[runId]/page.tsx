import type { Metadata } from "next";
import { RunView } from "../../../components/RunView";

export const metadata: Metadata = { title: "Test run" };

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <RunView runId={runId} />;
}
