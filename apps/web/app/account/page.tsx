import type { Metadata } from "next";
import { AccountSettings } from "../../components/AccountSettings";

export const metadata: Metadata = { title: "Your account" };

export default function AccountPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <p className="eyebrow">Account</p>
        <h1 className="page-title">Your account</h1>
      </div>
      <AccountSettings />
    </div>
  );
}
