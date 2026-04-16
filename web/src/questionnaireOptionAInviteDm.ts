import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, nip19, nip44, type NostrEvent } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "./nostrPublishQueue";
import { getSharedNostrPool } from "./sharedNostrPool";
import { SIMPLE_DM_RELAYS } from "./simpleShardDm";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import type { ElectionInviteMessage } from "./questionnaireOptionA";
import type { SignerService } from "./services/signerService";

const OPTION_A_INVITE_DM_RELAYS_MAX = 3;
const OPTION_A_INVITE_DM_READ_RELAYS_MAX = 3;
const OPTION_A_INVITE_DM_MAX_WAIT_MS = 1500;
const OPTION_A_INVITE_DM_STAGGER_MS = 250;
const OPTION_A_INVITE_DM_MIN_PUBLISH_INTERVAL_MS = 300;
const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;
const KIND_SEAL = 13;
const KIND_RUMOR_MESSAGE = 14;
const KIND_GIFT_WRAP = 1059;

type InviteDmEnvelope = {
  type: "optiona_invite_dm";
  schemaVersion: 1;
  invite: ElectionInviteMessage;
  sentAt: string;
};

function toHexPubkey(pubkey: string) {
  const value = pubkey.trim();
  if (value.startsWith("npub1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub") {
      throw new Error("Expected npub.");
    }
    return decoded.data as string;
  }
  return value;
}

function toNpub(pubkey: string) {
  const value = pubkey.trim();
  if (value.startsWith("npub1")) {
    return value;
  }
  return nip19.npubEncode(value);
}

function buildRelays(relays?: string[]) {
  return normalizeRelaysRust([...(relays ?? []), ...SIMPLE_DM_RELAYS]);
}

function selectReadRelays(relays: string[]) {
  return relays.slice(0, Math.min(OPTION_A_INVITE_DM_READ_RELAYS_MAX, relays.length));
}

function selectPublishRelays(relays: string[]) {
  return relays.slice(0, Math.min(OPTION_A_INVITE_DM_RELAYS_MAX, relays.length));
}

function parseInviteDmContent(content: string): ElectionInviteMessage | null {
  try {
    const parsed = JSON.parse(content) as Partial<InviteDmEnvelope> | ElectionInviteMessage;
    const invite = (parsed as InviteDmEnvelope).type === "optiona_invite_dm"
      ? (parsed as InviteDmEnvelope).invite
      : parsed as ElectionInviteMessage;
    if (
      invite?.type !== "election_invite"
      || invite.schemaVersion !== 1
      || typeof invite.electionId !== "string"
      || typeof invite.invitedNpub !== "string"
      || typeof invite.coordinatorNpub !== "string"
    ) {
      return null;
    }
    return invite;
  } catch {
    return null;
  }
}

function randomNow() {
  const now = Math.round(Date.now() / 1000);
  return Math.round(now - (Math.random() * TWO_DAYS_SECONDS));
}

function createRumor(input: {
  senderHex: string;
  envelope: InviteDmEnvelope;
}) {
  const rumor = {
    kind: KIND_RUMOR_MESSAGE,
    created_at: Math.round(Date.now() / 1000),
    tags: [],
    content: JSON.stringify(input.envelope),
    pubkey: input.senderHex,
  };
  return {
    ...rumor,
    id: getEventHash(rumor),
  };
}

function parseGiftWrapPayload(payload: string): NostrEvent | null {
  try {
    const parsed = JSON.parse(payload) as NostrEvent;
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.kind !== KIND_SEAL
      || typeof parsed.pubkey !== "string"
      || typeof parsed.content !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function publishOptionAInviteDm(input: {
  signer: SignerService;
  invite: ElectionInviteMessage;
  relays?: string[];
}) {
  if (!input.signer.nip44Encrypt) {
    throw new Error("Signer does not support NIP-44 encryption.");
  }

  const senderRaw = await input.signer.getPublicKey();
  const senderHex = toHexPubkey(senderRaw);
  const recipientHex = toHexPubkey(input.invite.invitedNpub);
  const envelope: InviteDmEnvelope = {
    type: "optiona_invite_dm",
    schemaVersion: 1,
    invite: input.invite,
    sentAt: new Date().toISOString(),
  };

  const rumor = createRumor({ senderHex, envelope });
  const sealCiphertext = await input.signer.nip44Encrypt(recipientHex, JSON.stringify(rumor));
  const signedSeal = await input.signer.signEvent({
    kind: KIND_SEAL,
    created_at: randomNow(),
    tags: [],
    content: sealCiphertext,
  });

  const giftWrapSecret = generateSecretKey();
  const giftWrapConversationKey = nip44.v2.utils.getConversationKey(giftWrapSecret, recipientHex);
  const wrappedSeal = nip44.v2.encrypt(JSON.stringify(signedSeal), giftWrapConversationKey);
  const giftWrapEvent = finalizeEvent({
    kind: KIND_GIFT_WRAP,
    created_at: randomNow(),
    tags: [["p", recipientHex]],
    content: wrappedSeal,
  }, giftWrapSecret);

  const relays = selectPublishRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], giftWrapEvent, { maxWait: OPTION_A_INVITE_DM_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: OPTION_A_INVITE_DM_STAGGER_MS },
    ),
    {
      channel: `optiona-invite-dm:${toNpub(senderHex)}:${input.invite.invitedNpub}`,
      minIntervalMs: OPTION_A_INVITE_DM_MIN_PUBLISH_INTERVAL_MS,
    },
  );

  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: relays[index], success: true as const }
      : {
          relay: relays[index],
          success: false as const,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));
  return {
    eventId: giftWrapEvent.id,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
    relayResults,
  };
}

export async function fetchOptionAInviteDms(input: {
  signer: SignerService;
  electionId?: string;
  relays?: string[];
  limit?: number;
}) {
  if (!input.signer.nip44Decrypt) {
    return [] as ElectionInviteMessage[];
  }
  const recipientRaw = await input.signer.getPublicKey();
  const recipientNpub = toNpub(recipientRaw);
  const recipientHex = toHexPubkey(recipientRaw);
  const relays = selectReadRelays(buildRelays(input.relays));
  const pool = getSharedNostrPool();
  const events = await pool.querySync(relays, {
    kinds: [KIND_GIFT_WRAP],
    "#p": [recipientHex],
    limit: Math.max(1, input.limit ?? 50),
  });

  const unique = new Map<string, ElectionInviteMessage>();
  const sorted = [...events].sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0));
  for (const event of sorted) {
    const wrapPubkey = typeof event.pubkey === "string" ? event.pubkey : "";
    if (!wrapPubkey || typeof event.content !== "string" || !event.content.trim()) {
      continue;
    }
    try {
      const sealPayload = await input.signer.nip44Decrypt(wrapPubkey, event.content);
      const sealEvent = parseGiftWrapPayload(sealPayload);
      if (!sealEvent) {
        continue;
      }
      const rumorPayload = await input.signer.nip44Decrypt(sealEvent.pubkey, sealEvent.content);
      const rumor = JSON.parse(rumorPayload) as { content?: string };
      if (!rumor || typeof rumor.content !== "string") {
        continue;
      }
      const invite = parseInviteDmContent(rumor.content);
      if (!invite) {
        continue;
      }
      if (invite.invitedNpub !== recipientNpub) {
        continue;
      }
      if (input.electionId?.trim() && invite.electionId !== input.electionId.trim()) {
        continue;
      }
      const key = `${invite.electionId}:${invite.coordinatorNpub}`;
      if (!unique.has(key)) {
        unique.set(key, invite);
      }
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}
