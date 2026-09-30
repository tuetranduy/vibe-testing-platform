import type { Metadata } from "next";
import { Suites } from "../../components/Suites";

export const metadata: Metadata = { title: "Suites" };

/** Suites (V1.2): saved Playwright tests that run together, with no AI. */
export default function SuitesPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <h1 className="page-title">Suites</h1>
        <p className="page-lede">
          Saved Playwright tests that run together — by hand, on a schedule or from CI. No exploring and no AI: each test repeats what
          its run recorded.
        </p>
      </div>
      <Suites />
    </div>
  );
}
