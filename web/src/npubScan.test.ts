import { describe, expect, it } from "vitest";
import { extractNpubFromScan } from "./npubScan";

describe("extractNpubFromScan", () => {
  const npub = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqujme";

  it("returns a plain npub", () => {
    expect(extractNpubFromScan(npub)).toBe(npub);
  });

  it("returns an npub from a nostr URI", () => {
    expect(extractNpubFromScan(`nostr:${npub}`)).toBe(npub);
  });

  it("returns an npub embedded in a URL", () => {
    expect(extractNpubFromScan(`https://njump.me/${npub}`)).toBe(npub);
  });

  it("returns null when the scan content has no valid npub", () => {
    expect(extractNpubFromScan("https://example.com/not-a-npub")).toBeNull();
  });
});
