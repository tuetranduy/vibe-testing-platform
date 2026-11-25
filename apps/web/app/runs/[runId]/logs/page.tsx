import type { Metadata } from "next";
import { RunLogsPage } from "../../../../components/RunLogs/RunLogs";

export const metadata: Metadata = { title: "Run logs" };

/** Admin run logs (2026-11-25): one run's lines from every source and its model calls, full page. */
export default async function RunLogsRoute({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <RunLogsPage runId={runId} />;
}
