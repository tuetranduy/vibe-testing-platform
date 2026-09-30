import type { Metadata } from "next";
import { SuiteDetailView } from "../../../components/SuiteDetailView";

export const metadata: Metadata = { title: "Suite" };

export default async function SuitePage({ params }: { params: Promise<{ suiteId: string }> }) {
  const { suiteId } = await params;
  return <SuiteDetailView suiteId={suiteId} />;
}
