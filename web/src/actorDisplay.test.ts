import { describe, expect, it } from "vitest";
import { deriveActorDisplayId } from "./actorDisplay";

describe("deriveActorDisplayId", () => {
  it("uses the first and last 3 chars after npub1", () => {
    expect(deriveActorDisplayId("npub1abcdeffedcba")).toBe("abc-cba");
  });

  it("falls back for non-npub inputs", () => {
    expect(deriveActorDisplayId("abcdefghi")).toBe("abc-ghi");
    expect(deriveActorDisplayId("abcdef")).toBe("abcdef");
    expect(deriveActorDisplayId("")).toBe("unknown");
  });
});
