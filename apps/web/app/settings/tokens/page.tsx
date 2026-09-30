import type { Metadata } from "next";
import { ApiTokens } from "../../../components/ApiTokens";
import { SettingsNav } from "../../../components/SettingsNav";

export const metadata: Metadata = { title: "API tokens" };

/** Settings → API tokens (administrators, V1.2): everyone's tokens, to revoke. */
export default function AllTokensPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">API tokens</h1>
        <p className="page-lede">Every token in the workspace. Each person creates their own on their account page.</p>
      </div>
      <SettingsNav />
      <ApiTokens all />
    </div>
  );
}
