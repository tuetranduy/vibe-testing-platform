import type { Metadata } from "next";
import { SettingsNav } from "../../../components/SettingsNav";
import { UserAdmin } from "../../../components/UserAdmin";

export const metadata: Metadata = { title: "Users" };

/** Settings → Users (administrators). */
export default function UsersPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">Users</h1>
        <p className="page-lede">Members see and run their own tests. Administrators see everyone&apos;s, and manage users and settings.</p>
      </div>
      <SettingsNav />
      <UserAdmin />
    </div>
  );
}
