import type { Metadata } from "next";
import { BrandMark } from "../../components/Brand";
import { LoginForm } from "../../components/LoginForm";

export const metadata: Metadata = { title: "Sign in" };

/** Sign-in (V1.1 F1). `next`: the page the user was sent here from; `org`: the organization (tenant) to sign in to. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[]; org?: string | string[] }> }) {
  const { next, org } = await searchParams;
  const tenant = typeof org === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(org) ? org : null;
  return (
    <div className="login-page relative isolate grid min-h-[calc(100dvh-140px)] content-center place-items-center gap-7">
      <div className="flex flex-col items-center gap-3.5 text-center [&_.brand-mark]:size-12 [&_.brand-mark]:rounded-xl">
        <BrandMark size={48} />
        <span className="text-sm font-medium tracking-[-0.01em] text-muted-foreground">AI Testing Platform</span>
      </div>
      <LoginForm next={typeof next === "string" ? next : null} tenant={tenant} />
    </div>
  );
}
