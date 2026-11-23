import type { Metadata } from "next";
import { SettingsNav } from "../../../components/SettingsNav";
import { UserAdmin } from "../../../components/UserAdmin";

export const metadata: Metadata = { title: "Users" };

/** Settings → Users (administrators). */
export default function UsersPage() {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <div className="title-block flex min-w-0 flex-col gap-2">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">Users</h1>
        <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">Members see and run their own tests. Administrators see everyone&apos;s, and manage users and settings.</p>
      </div>
      <SettingsNav />
      <UserAdmin />
    </div>
  );
}
