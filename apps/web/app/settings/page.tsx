import type { Metadata } from "next";
import { LlmSettings } from "../../components/LlmSettings";

export const metadata: Metadata = { title: "Settings" };

/** Settings: the AI providers' API keys and the model new tests use by default. */
export default function SettingsPage() {
  return (
    <div className="stack-lg">
      <div className="title-block">
        <p className="eyebrow">Settings</p>
        <h1 className="page-title">AI providers and models</h1>
        <p className="page-lede">
          The keys the platform uses to reach each AI provider, and the model new tests run on. Changes apply to new tests only.
        </p>
      </div>
      <LlmSettings />
    </div>
  );
}
