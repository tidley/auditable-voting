import { describe, expect, it } from "vitest";
import { getQuestionnaireReadRelays } from "./questionnaireNostr";

describe("questionnaireNostr relay selection", () => {
  it("does not use relays that reject questionnaire tag reads", () => {
    const relays = getQuestionnaireReadRelays([
      "wss://relay.damus.io",
      "wss://relay.primal.net",
      "wss://nostr.wine",
      "wss://nostr.mom",
      "wss://relay.nostr.net",
      "wss://nos.lol",
      "wss://relay.nostr.info",
      "wss://relay.nos.social",
    ], 8);

    expect(relays).toContain("wss://relay.nostr.net");
    expect(relays).toContain("wss://nos.lol");
    expect(relays).toContain("wss://relay.nostr.info");
    expect(relays).toContain("wss://relay.nos.social");
    expect(relays).not.toContain("wss://relay.damus.io");
    expect(relays).not.toContain("wss://relay.primal.net");
    expect(relays).not.toContain("wss://nostr.wine");
    expect(relays).not.toContain("wss://nostr.mom");
  });
});
