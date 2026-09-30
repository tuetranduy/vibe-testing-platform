import type { Metadata } from "next";
import { LoginForm } from "../../components/LoginForm";

export const metadata: Metadata = { title: "Sign in" };

/** Sign-in (V1.1 F1). `next`: the page the user was sent here from. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <div className="login-page">
      <LoginForm next={typeof next === "string" ? next : null} />
    </div>
  );
}
