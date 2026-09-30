import type { Metadata } from "next";
import { CredentialProfiles } from "../../../components/CredentialProfiles";
import { SettingsNav } from "../../../components/SettingsNav";

export const metadata: Metadata = { title: "Credentials" };

/** Settings → Credentials: saved, encrypted test-account secrets (V1.1). */
export default function CredentialsPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">Saved credentials</h1>
        <p className="page-lede">
          Test accounts&apos; logins, stored encrypted. A test started with them gets its own copy of the values, which is deleted when the
          run ends; the AI never sees them.
        </p>
      </div>
      <SettingsNav />
      <CredentialProfiles />
    </div>
  );
}
