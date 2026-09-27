import { bootWorker } from "../../../apps/worker/src/boot";
import { ScriptedExplorer } from "../scripted-explorer";
import { DEMO_SHOP_SCRIPT, SCENARIOS } from "./scenarios";
import { ScenarioTransport } from "./scripted-llm";

// E2E_MODE=live: the real provider (LLM_PROVIDER: anthropic or gemini) and Stagehand. Otherwise the
// scripted model and explorer: everything else — sandbox, runner, storage, queues — is the real worker.
const live = process.env.E2E_MODE === "live";
await bootWorker(
  live ? {} : { engine: { transport: new ScenarioTransport(SCENARIOS), exploration: { explorer: new ScriptedExplorer(DEMO_SHOP_SCRIPT) } } },
);
