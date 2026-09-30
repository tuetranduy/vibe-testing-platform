import type { Metadata } from "next";
import { SuiteRunPage } from "../../../components/SuiteRunPage";

export const metadata: Metadata = { title: "Suite run" };

export default async function SuiteRunRoute({ params }: { params: Promise<{ suiteRunId: string }> }) {
  const { suiteRunId } = await params;
  return <SuiteRunPage suiteRunId={suiteRunId} />;
}
