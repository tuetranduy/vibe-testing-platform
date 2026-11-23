import type { Metadata } from "next";
import { ApiTokens } from "../../../components/ApiTokens";
import { SettingsNav } from "../../../components/SettingsNav";

export const metadata: Metadata = { title: "API tokens" };

/** Settings → API tokens (administrators, V1.2): everyone's tokens, to revoke. */
export default function AllTokensPage() {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <div className="title-block flex min-w-0 flex-col gap-2">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">API tokens</h1>
        <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">Every token in the workspace. Each person creates their own on their account page.</p>
      </div>
      <SettingsNav />
      <ApiTokens all />
    </div>
  );
}
