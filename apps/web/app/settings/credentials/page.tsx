import { redirect } from "next/navigation";

/** Retired setup screens send existing bookmarks to Settings. */
export default function RetiredSettingsPage() { redirect("/settings"); }
