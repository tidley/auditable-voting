import { describe, expect, it } from "vitest";
import { deriveActorDisplayId } from "./actorDisplay";

describe("deriveActorDisplayId", () => {
  it("uses the first 7 chars after npub1", () => {
    expect(deriveActorDisplayId("npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqq")).toBe("qqqqqqq");
  });

  it("falls back for non-npub inputs", () => {
    expect(deriveActorDisplayId("abcdefghi")).toBe("abcdefg");
    expect(deriveActorDisplayId("")).toBe("unknown");
  });
});
