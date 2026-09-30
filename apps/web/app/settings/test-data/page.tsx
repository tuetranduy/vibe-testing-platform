import type { Metadata } from "next";
import { SettingsNav } from "../../../components/SettingsNav";
import { TestDataSets } from "../../../components/TestDataSets";

export const metadata: Metadata = { title: "Test data" };

/** Settings → Test data: reusable sets of test data (V1.1). */
export default function TestDataPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">Test data</h1>
        <p className="page-lede">
          Named sets of values a new test can start from. Values typed on the new-test form win over the set&apos;s.
        </p>
      </div>
      <SettingsNav />
      <TestDataSets />
    </div>
  );
}
