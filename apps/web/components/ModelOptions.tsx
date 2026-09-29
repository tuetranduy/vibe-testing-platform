import type { CatalogEntry } from "./llm-format";
import { modelGroups } from "./llm-format";

/** The offered models as <optgroup>s by provider; a model whose provider has no key is disabled ("add a key"). */
export function ModelOptions({ models }: { models: readonly CatalogEntry[] }) {
  return (
    <>
      {modelGroups(models).map((group) => (
        <optgroup key={group.provider} label={group.label}>
          {group.models.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.available}>
              {m.available ? m.label : `${m.label} — add a key`}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
