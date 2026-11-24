import type { Metadata } from "next";
import { DiscoveryRolloutCard } from "../../components/DiscoveryRolloutCard";
import { ExplorationCacheCard } from "../../components/ExplorationCacheCard";
import { LlmSettings } from "../../components/LlmSettings";
import { SettingsNav } from "../../components/SettingsNav";

export const metadata: Metadata = { title: "Settings" };

/** Settings: the AI providers' API keys and the model new tests use by default. */
export default function SettingsPage() {
  return (
    <div className="flex min-w-0 flex-col gap-7">
      <div className="title-block flex min-w-0 flex-col gap-2">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">AI providers and models</h1>
        <p className="max-w-[650px] text-[0.95rem] leading-[1.7] text-muted-foreground">
          The keys the platform uses to reach each AI provider, and the model new tests run on. Changes apply to new tests only.
        </p>
      </div>
      <SettingsNav />
      <LlmSettings />
      <DiscoveryRolloutCard />
      <ExplorationCacheCard />
    </div>
  );
}
