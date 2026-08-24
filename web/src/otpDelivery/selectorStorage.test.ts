// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadSelectedChannel,
  saveSelectedChannel,
  CHANNEL_STORAGE_PREFIX,
} from "./selectorStorage";

const ELECTION_ID = "election-abc";

beforeEach(() => {
  window.localStorage.clear();
});

describe("channel selector persistence", () => {
  it("returns the manual channel id when nothing is stored", () => {
    expect(loadSelectedChannel(ELECTION_ID)).toBe("manual");
  });

  it("persists a selected channel per election", () => {
    saveSelectedChannel(ELECTION_ID, "email-nomail");
    expect(loadSelectedChannel(ELECTION_ID)).toBe("email-nomail");
  });

  it("keeps selections isolated between elections", () => {
    saveSelectedChannel(ELECTION_ID, "sms");
    expect(loadSelectedChannel("election-other")).toBe("manual");
  });

  it("falls back to manual for an unknown stored value", () => {
    window.localStorage.setItem(
      `${CHANNEL_STORAGE_PREFIX}${ELECTION_ID}`,
      "not-a-channel",
    );
    expect(loadSelectedChannel(ELECTION_ID)).toBe("manual");
  });

  it("uses a namespaced storage key", () => {
    saveSelectedChannel(ELECTION_ID, "sms");
    const keys = Object.keys(window.localStorage);
    expect(keys.some((key) => key.startsWith(CHANNEL_STORAGE_PREFIX))).toBe(true);
  });
});
