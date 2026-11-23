import type { Metadata } from "next";
import { AccountSessions } from "../../components/AccountSessions";
import { AccountSettings } from "../../components/AccountSettings";

export const metadata: Metadata = { title: "Your account" };

export default function AccountPage() {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <div className="title-block flex min-w-0 flex-col gap-2">
        <p className="eyebrow">Account</p>
        <h1 className="page-title">Your account</h1>
        <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">
          <a href="/account/tokens">API tokens</a> let CI jobs and scripts run your suites.
        </p>
      </div>
      <AccountSettings />
      <AccountSessions />
    </div>
  );
}
