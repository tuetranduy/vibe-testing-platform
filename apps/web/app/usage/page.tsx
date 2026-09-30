import type { Metadata } from "next";
import { UsageDashboard } from "../../components/UsageDashboard";

export const metadata: Metadata = { title: "Usage" };

/** Model spend of recent test runs (V1.1). */
export default function UsagePage() {
  return <UsageDashboard />;
}
