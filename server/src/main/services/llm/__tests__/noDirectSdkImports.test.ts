import { readFileSync } from "fs";
import { join } from "path";

/**
 * JAK-141 — the router and every specialist writer must go through the
 * provider-agnostic {@link import("../LlmClient").LlmClient} layer, NOT a raw
 * provider SDK. This guard reads their source and fails if any of them imports
 * `@anthropic-ai/sdk` or `openai` directly, so a future edit can't quietly
 * re-couple a caller to one provider.
 */
const SERVICES_DIR = join(__dirname, "..", "..");

const CALLER_FILES = [
  "orchestrator/RouterLlmClient.ts",
  "PropertyReportWriter.ts",
  "skiptrace/SkipTraceReportWriter.ts",
  "comps/CompsReportWriter.ts",
];

describe("JAK-141 — router + specialists route through the LlmClient layer, not a raw SDK", () => {
  it.each(CALLER_FILES)("%s imports no provider SDK directly", (rel) => {
    const src = readFileSync(join(SERVICES_DIR, rel), "utf8");
    expect(src).not.toMatch(/from\s+["']@anthropic-ai\/sdk["']/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
  });
});
