import type { Metadata } from "next";
import { BrandMark } from "../../components/Brand";
import { LoginForm } from "../../components/LoginForm";

export const metadata: Metadata = { title: "Sign in" };

/** Sign-in (V1.1 F1). `next`: the page the user was sent here from. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return (
    <div className="login-page">
      <div className="login-brand">
        <BrandMark size={48} />
        <span className="login-brand-name">AI Testing Platform</span>
      </div>
      <LoginForm next={typeof next === "string" ? next : null} />
    </div>
  );
}
