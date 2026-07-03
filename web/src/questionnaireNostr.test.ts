import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getQuestionnaireReadRelays,
  parseQuestionnaireAdmissionAnnouncementEvent,
  QUESTIONNAIRE_ADMISSION_ANNOUNCEMENT_KIND,
  queryQuestionnaireEvents,
} from "./questionnaireNostr";

const sharedNostrPoolMocks = vi.hoisted(() => ({
  querySync: vi.fn(),
}));

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => sharedNostrPoolMocks,
}));

beforeEach(() => {
  sharedNostrPoolMocks.querySync.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

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

describe("questionnaireNostr relay queries", () => {
  it("times out stuck public relay queries", async () => {
    vi.useFakeTimers();
    sharedNostrPoolMocks.querySync.mockReturnValue(new Promise(() => undefined));

    const query = queryQuestionnaireEvents(
      ["wss://relay.example"],
      { kinds: [QUESTIONNAIRE_ADMISSION_ANNOUNCEMENT_KIND], limit: 1 },
      { timeoutMs: 250 },
    );
    const assertion = expect(query).rejects.toThrow("Questionnaire relay query timed out after 250ms.");

    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});

describe("questionnaire admission announcements", () => {
  it("parses public admitted-questionnaire announcements", () => {
    const event = {
      kind: QUESTIONNAIRE_ADMISSION_ANNOUNCEMENT_KIND,
      content: JSON.stringify({
        schemaVersion: 1,
        eventType: "questionnaire_admission_announcement",
        questionnaireId: "q_demo",
        coordinatorPubkey: "npub1coord",
        title: "Demo questionnaire",
        description: "One question",
        state: "open",
        createdAt: 1_700_000_000,
        questionnaireRelays: [" wss://relay.example ", "wss://relay.example"],
      }),
    };

    expect(parseQuestionnaireAdmissionAnnouncementEvent(event)).toEqual({
      schemaVersion: 1,
      eventType: "questionnaire_admission_announcement",
      questionnaireId: "q_demo",
      coordinatorPubkey: "npub1coord",
      title: "Demo questionnaire",
      description: "One question",
      state: "open",
      createdAt: 1_700_000_000,
      questionnaireRelays: ["wss://relay.example"],
    });
  });
});
