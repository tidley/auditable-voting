import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip17, nip19 } from "nostr-tools";
import {
  contentIsQuestionnaireInviteLinkOnly,
  fetchHelplineDmMessages,
  resetHelplineDmMessageFeedsForTests,
  sendHelplineDmMessage,
  subscribeHelplineDmMessages,
  type HelplineDmMessage,
} from "./simpleHelplineDm";

const querySync = vi.fn();
const publish = vi.fn();
const subscribeMany = vi.fn();

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ querySync, publish, subscribeMany }),
}));

describe("simpleHelplineDm", () => {
  beforeEach(() => {
    resetHelplineDmMessageFeedsForTests();
    querySync.mockReset();
    querySync.mockResolvedValue([]);
    publish.mockReset();
    subscribeMany.mockReset();
    subscribeMany.mockReturnValue({ close: vi.fn() });
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

  it("reads a message produced by the helpline send path", async () => {
    const senderSecret = generateSecretKey();
    const senderNsec = nip19.nsecEncode(senderSecret);
    const recipientSecret = generateSecretKey();
    const recipientNpub = nip19.npubEncode(getPublicKey(recipientSecret));
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const publishedEvents: Array<ReturnType<typeof nip17.wrapEvent>> = [];
    publish.mockImplementation((_relays: string[], event: ReturnType<typeof nip17.wrapEvent>) => {
      publishedEvents.push(event);
      return [Promise.resolve(undefined)];
    });

    await sendHelplineDmMessage({
      senderNsec,
      recipientNpub,
      message: "Can you check my invite?",
      relays: ["wss://relay.example"],
    });
    querySync.mockResolvedValue(publishedEvents);

    const messages = await fetchHelplineDmMessages({
      actorNsec: recipientNsec,
      relays: ["wss://relay.example"],
    });

    expect(messages.map((message) => message.body)).toEqual(["Can you check my invite?"]);
  });

  it("shares one actor feed between listeners and replays cached live messages", async () => {
    const actorSecret = generateSecretKey();
    const actorHex = getPublicKey(actorSecret);
    const actorNsec = nip19.nsecEncode(actorSecret);
    const peerSecret = generateSecretKey();
    const peerNpub = nip19.npubEncode(getPublicKey(peerSecret));
    const firstSnapshots: HelplineDmMessage[][] = [];
    const secondSnapshots: HelplineDmMessage[][] = [];
    let liveEventHandler: ((event: ReturnType<typeof nip17.wrapEvent>) => void) | undefined;

    subscribeMany.mockImplementation((_relays, _filter, handlers) => {
      liveEventHandler = handlers.onevent;
      return { close: vi.fn() };
    });

    const unsubscribeFirst = subscribeHelplineDmMessages({
      actorNsec,
      relays: ["wss://relay.example"],
      onMessages: (messages) => firstSnapshots.push(messages),
    });

    await vi.waitFor(() => {
      expect(querySync).toHaveBeenCalledTimes(1);
      expect(subscribeMany).toHaveBeenCalledTimes(1);
    });

    const liveMessage = nip17.wrapEvent(
      peerSecret,
      { publicKey: actorHex, relayUrl: "wss://relay.example" },
      "Message already seen by the unread badge.",
      "Auditable Voting helpline",
    );
    liveEventHandler?.(liveMessage);

    expect(firstSnapshots.at(-1)?.map((message) => message.body)).toEqual([
      "Message already seen by the unread badge.",
    ]);

    const unsubscribeSecond = subscribeHelplineDmMessages({
      actorNsec,
      relays: ["wss://relay.example"],
      allowedPeerNpubs: [peerNpub],
      onMessages: (messages) => secondSnapshots.push(messages),
    });

    expect(querySync).toHaveBeenCalledTimes(1);
    expect(subscribeMany).toHaveBeenCalledTimes(1);
    expect(secondSnapshots.at(-1)?.map((message) => message.body)).toEqual([
      "Message already seen by the unread badge.",
    ]);

    unsubscribeFirst();
    unsubscribeSecond();
  });
});
