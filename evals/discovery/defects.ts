import manifest from "./defects.json" with { type: "json" };

/**
 * Phase C: exploratory findings measured against known defects (`defects.json`, the `/benchmark/defects/` fixture).
 * A finding matches a defect when it is on the defect's page and its title or observation matches the defect's
 * pattern; a finding on a healthy page is a false alarm. Precision counts every finding, recall every defect.
 */
export interface DefectManifest {
  fixture: string;
  defects: { id: string; path: string; pattern: string; description: string }[];
  healthy: string[];
}
export const DEFECTS: DefectManifest = manifest;

export interface ScoredFindings {
  matched: Record<string, string[]>;
  missed: string[];
  falseAlarms: number;
  unmatched: number;
  precision: number | null;
  recall: number;
}

export function scoreFindings(findings: readonly { path: string; title: string; observation: string }[], defects: DefectManifest = DEFECTS): ScoredFindings {
  const matched: Record<string, string[]> = {};
  let unmatched = 0;
  for (const finding of findings) {
    const hit = defects.defects.find((d) => d.path === finding.path && new RegExp(d.pattern, "i").test(`${finding.title} ${finding.observation}`));
    if (hit) (matched[hit.id] ??= []).push(finding.title);
    else unmatched++;
  }
  const found = Object.keys(matched).length;
  return {
    matched,
    missed: defects.defects.filter((d) => !matched[d.id]).map((d) => d.id),
    falseAlarms: findings.filter((f) => defects.healthy.includes(f.path)).length,
    unmatched,
    precision: findings.length ? (findings.length - unmatched) / findings.length : null,
    recall: found / defects.defects.length,
  };
}
