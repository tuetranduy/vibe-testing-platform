import { readFileSync } from "node:fs";
import { scoreReview } from "./ratings";

const [resultsFile, ratingsFile] = process.argv.slice(2);
if (!resultsFile || !ratingsFile) {
  console.error("Usage: pnpm exec tsx evals/discovery/score-ratings.ts <results.hosted.json> <candidates-for-rating.hosted.json>");
  process.exit(2);
}

try {
  const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
  console.log(JSON.stringify(scoreReview(read(resultsFile), read(ratingsFile)), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not score the ratings");
  process.exitCode = 1;
}
