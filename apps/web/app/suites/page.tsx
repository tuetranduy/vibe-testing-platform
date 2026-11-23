import type { Metadata } from "next";
import { Suites } from "../../components/Suites";

export const metadata: Metadata = { title: "Suites" };

/** Suites (V1.2): saved Playwright tests that run together, with no AI. */
export default function SuitesPage() {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <div className="title-block flex min-w-0 flex-col gap-2">
        <h1 className="page-title">Suites</h1>
        <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">
          Saved Playwright tests that run together — by hand, on a schedule or from CI. No exploring and no AI: each test repeats what
          its run recorded.
        </p>
      </div>
      <Suites />
    </div>
  );
}
