import type { Metadata } from "next";
import { RunHistory } from "../../components/RunHistory";

export const metadata: Metadata = { title: "Test runs" };

/** The run history: its title, overview and filters live in RunHistory, next to the data they describe. */
export default function RunsPage() {
  return <RunHistory />;
}
