import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip17, nip19 } from "nostr-tools";
import {
  contentIsQuestionnaireInviteLinkOnly,
  fetchHelplineDmMessages,
} from "./simpleHelplineDm";

const querySync = vi.fn();
const publish = vi.fn();
const subscribeMany = vi.fn();

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ querySync, publish, subscribeMany }),
}));

describe("simpleHelplineDm", () => {
  beforeEach(() => {
    querySync.mockReset();
    publish.mockReset();
    subscribeMany.mockReset();
  });

  it("recognises a bare voter questionnaire link", () => {
    expect(contentIsQuestionnaireInviteLinkOnly(
      "https://tidley.github.io/auditable-voting/?role=voter&q=q_public_123&request_ballot=1",
    )).toBe(true);
    expect(contentIsQuestionnaireInviteLinkOnly(
      "<https://tidley.github.io/auditable-voting/?role=voter&questionnaire=q_public_123>",
    )).toBe(true);
    expect(contentIsQuestionnaireInviteLinkOnly(
      "Questionnaire: https://tidley.github.io/auditable-voting/?role=voter&q=q_public_123",
    )).toBe(false);
    expect(contentIsQuestionnaireInviteLinkOnly("https://example.test/?role=voter")).toBe(false);
  });

  it("hides received questionnaire-link messages from the helpline inbox", async () => {
    const voterSecret = generateSecretKey();
    const voterHex = getPublicKey(voterSecret);
    const voterNsec = nip19.nsecEncode(voterSecret);
    const organiserSecret = generateSecretKey();
    const linkMessage = nip17.wrapEvent(
      organiserSecret,
      { publicKey: voterHex, relayUrl: "wss://relay.example" },
      "https://tidley.github.io/auditable-voting/?role=voter&q=q_hidden&request_ballot=1",
      "Auditable Voting helpline",
    );
    const visibleMessage = nip17.wrapEvent(
      organiserSecret,
      { publicKey: voterHex, relayUrl: "wss://relay.example" },
      "I have approved your invite.",
      "Auditable Voting helpline",
    );
    querySync.mockResolvedValue([linkMessage, visibleMessage]);

    const messages = await fetchHelplineDmMessages({
      actorNsec: voterNsec,
      relays: ["wss://relay.example"],
      hideReceivedQuestionnaireInviteLinks: true,
    });

    expect(messages.map((message) => message.body)).toEqual(["I have approved your invite."]);
  });

  it("keeps questionnaire-link messages unless the voter filter is enabled", async () => {
    const voterSecret = generateSecretKey();
    const voterHex = getPublicKey(voterSecret);
    const voterNsec = nip19.nsecEncode(voterSecret);
    const organiserSecret = generateSecretKey();
    const link = "https://tidley.github.io/auditable-voting/?role=voter&q=q_visible_without_filter";
    const linkMessage = nip17.wrapEvent(
      organiserSecret,
      { publicKey: voterHex, relayUrl: "wss://relay.example" },
      link,
      "Auditable Voting helpline",
    );
    querySync.mockResolvedValue([linkMessage]);

    const messages = await fetchHelplineDmMessages({
      actorNsec: voterNsec,
      relays: ["wss://relay.example"],
    });

    expect(messages.map((message) => message.body)).toEqual([link]);
  });
});
