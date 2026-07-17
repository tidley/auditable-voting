import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("questionnaire module boundary", () => {
  it("does not import the legacy simple flow", () => {
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const offenders = readdirSync(sourceDir)
      .filter((name) => name.startsWith("questionnaire") && name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => /from\s+["']\.\/simple/.test(readFileSync(join(sourceDir, name), "utf8")));

    expect(offenders).toEqual([]);
  });
});
