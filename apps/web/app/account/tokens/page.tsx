import type { Metadata } from "next";
import { ApiTokens } from "../../../components/ApiTokens";

export const metadata: Metadata = { title: "API tokens" };

/** Your API tokens (V1.2): for CI and scripts, through this app's /api/ext path. */
export default function TokensPage() {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <div className="title-block flex min-w-0 flex-col gap-2">
        <p className="eyebrow">Account</p>
        <h1 className="page-title">API tokens</h1>
        <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">
          Let a CI job or a script run your suites and read their results. Send the token as <code>Authorization: Bearer tap_…</code> to{" "}
          <code>/api/ext/v1/…</code> on this site.
        </p>
      </div>
      <ApiTokens />
    </div>
  );
}
