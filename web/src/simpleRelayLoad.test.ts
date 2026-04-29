import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

type StoredRelayEvent = {
  relay: string;
  event: {
    id: string;
    kind: number;
    pubkey: string;
    tags: string[][];
    content: string;
    created_at: number;
  };
};

const storedEvents: StoredRelayEvent[] = [];
const publishCalls: Array<{ relay: string; kind: number; eventId: string }> = [];

function matchesFilter(event: StoredRelayEvent["event"], filter: Record<string, unknown>) {
  const kinds = filter.kinds as number[] | undefined;
  if (kinds && !kinds.includes(event.kind)) {
    return false;
  }

  const authors = filter.authors as string[] | undefined;
  if (authors && !authors.includes(event.pubkey)) {
    return false;
  }

  const pTags = filter["#p"] as string[] | undefined;
  if (pTags) {
    const eventPTags = event.tags
      .filter((tag) => tag[0] === "p")
      .map((tag) => tag[1]);
    if (!pTags.some((tag) => eventPTags.includes(tag))) {
      return false;
    }
  }

  return true;
}

const publish = vi.fn((relays: string[], event: StoredRelayEvent["event"]) => (
  relays.map((relay) => {
    publishCalls.push({ relay, kind: event.kind, eventId: event.id });
    storedEvents.push({ relay, event });
    return Promise.resolve(undefined);
  })
));

const querySync = vi.fn(async (relays: string[], filter: Record<string, unknown>) => {
  const seen = new Set<string>();
  const results: StoredRelayEvent["event"][] = [];
  for (const entry of storedEvents) {
    if (!relays.includes(entry.relay) || seen.has(entry.event.id) || !matchesFilter(entry.event, filter)) {
      continue;
    }
    seen.add(entry.event.id);
    results.push(entry.event);
  }
  return results;
});

const subscribeMany = vi.fn(() => ({ close: vi.fn(async () => undefined) }));
const destroy = vi.fn();
const close = vi.fn();

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ publish, querySync, subscribeMany, destroy, close }),
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (task: () => Promise<unknown>) => task(),
  publishToRelaysStaggered: async (
    publishSingleRelay: (relay: string) => Promise<unknown>,
    relays: string[],
  ) => Promise.allSettled(relays.map((relay) => publishSingleRelay(relay))),
}));

vi.mock("./simpleShardCertificate", () => ({
  createSimpleBlindShareResponse: vi.fn((input: {
    coordinatorNpub: string;
    request: { requestId: string };
    shareIndex: number;
    thresholdT?: number;
    thresholdN?: number;
    keyAnnouncementEvent: { id: string };
  }) => ({
    shareId: `share-${input.request.requestId}`,
    requestId: input.request.requestId,
    coordinatorNpub: input.coordinatorNpub,
    blindedSignature: `signature-${input.request.requestId}`,
    shareIndex: input.shareIndex,
    thresholdT: input.thresholdT,
    thresholdN: input.thresholdN,
    createdAt: "2026-04-13T00:00:00.000Z",
    keyAnnouncementEvent: input.keyAnnouncementEvent,
  })),
}));

function actor() {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return {
    secretKey,
    publicKey,
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(publicKey),
  };
}

function relaysForEvent(kind: number, eventId: string) {
  return publishCalls
    .filter((call) => call.kind === kind && call.eventId === eventId)
    .map((call) => call.relay);
}

describe("simple relay load without browser", () => {
  beforeEach(() => {
    storedEvents.length = 0;
    publishCalls.length = 0;
    vi.clearAllMocks();
  });

  it("runs a stable 1 coordinator / 40 voters / 1 round mailbox relay scenario", async () => {
    const {
      fetchSimpleDmAcknowledgements,
      fetchSimpleShardRequests,
      fetchSimpleShardResponses,
      sendSimpleDmAcknowledgement,
      sendSimpleRoundTicket,
      sendSimpleShardRequest,
    } = await import("./simpleShardDm");
    const {
      SIMPLE_MAILBOX_ACK_KIND,
      SIMPLE_MAILBOX_REQUEST_KIND,
      SIMPLE_MAILBOX_TICKET_KIND,
    } = await import("./simpleMailbox");

    const coordinator = actor();
    const voters = Array.from({ length: 40 }, () => actor());
    const votingId = "load-round-1";

    for (const [index, voter] of voters.entries()) {
      await sendSimpleShardRequest({
        voterSecretKey: voter.secretKey,
        coordinatorNpub: coordinator.npub,
        voterNpub: voter.npub,
        replyNpub: voter.npub,
        votingId,
        blindRequest: {
          requestId: `request-${index + 1}`,
          votingId,
          blindedMessage: `blind-message-${index + 1}`,
          createdAt: "2026-04-13T00:00:00.000Z",
        },
      });
    }

    const requests = await fetchSimpleShardRequests({ coordinatorNsec: coordinator.nsec });
    expect(requests).toHaveLength(40);

    for (const request of requests) {
      await sendSimpleRoundTicket({
        coordinatorSecretKey: coordinator.secretKey,
        blindPrivateKey: {} as never,
        keyAnnouncementEvent: { id: "blind-key-1" },
        recipientNpub: request.replyNpub,
        coordinatorNpub: coordinator.npub,
        thresholdLabel: "1 of 1",
        request,
        votingPrompt: "Should the proposal pass?",
        shareIndex: 1,
        thresholdT: 1,
        thresholdN: 1,
      });
    }

    const voterResponses = await Promise.all(
      voters.map((voter) => fetchSimpleShardResponses({ voterNsec: voter.nsec })),
    );
    expect(voterResponses.every((responses) => responses.length === 1)).toBe(true);

    for (const [index, voter] of voters.entries()) {
      const response = voterResponses[index][0]!;
      await sendSimpleDmAcknowledgement({
        senderSecretKey: voter.secretKey,
        recipientNpub: coordinator.npub,
        actorNpub: voter.npub,
        ackedAction: "simple_round_ticket",
        ackedEventId: response.id,
        votingId,
        requestId: response.requestId,
        responseId: response.id,
        mailboxId: response.mailboxId,
      });
    }

    const acknowledgements = await fetchSimpleDmAcknowledgements({ actorNsec: coordinator.nsec });
    expect(acknowledgements.filter((ack) => ack.ackedAction === "simple_round_ticket")).toHaveLength(40);

    const ticketEventIds = new Set(
      publishCalls
        .filter((call) => call.kind === SIMPLE_MAILBOX_TICKET_KIND)
        .map((call) => call.eventId),
    );
    expect(ticketEventIds.size).toBe(40);

    const secondaryTicketRelays = new Set<string>();
    const anchorsSeen = new Set<string>();
    for (const ticketEventId of ticketEventIds) {
      const relays = relaysForEvent(SIMPLE_MAILBOX_TICKET_KIND, ticketEventId);
      expect(relays).toHaveLength(5);
      const anchors = relays.filter(
        (relay) => relay === "wss://relay.nostr.net" || relay === "wss://nos.lol",
      );
      expect(anchors.length).toBeGreaterThanOrEqual(1);
      for (const anchor of anchors) {
        anchorsSeen.add(anchor);
      }
      for (const relay of relays) {
        if (relay !== "wss://relay.nostr.net" && relay !== "wss://nos.lol") {
          secondaryTicketRelays.add(relay);
        }
      }
    }

    expect(anchorsSeen.size).toBeGreaterThanOrEqual(2);
    expect(secondaryTicketRelays.size).toBeGreaterThanOrEqual(3);
    expect(publishCalls.filter((call) => call.kind === SIMPLE_MAILBOX_REQUEST_KIND)).toHaveLength(40 * 5);
    expect(publishCalls.filter((call) => call.kind === SIMPLE_MAILBOX_TICKET_KIND)).toHaveLength(40 * 5);
    expect(publishCalls.filter((call) => call.kind === SIMPLE_MAILBOX_ACK_KIND)).toHaveLength(40 * 5);
  });
});
