import { finalizeEvent, getPublicKey, nip19, verifyEvent, type VerifiedEvent } from "nostr-tools";
import { sha256Hex } from "./tokenIdentity";

export const SIMPLE_SHARD_CERTIFICATE_KIND = 38993;

export type SimpleShardCertificate = VerifiedEvent;

export type ParsedSimpleShardCertificate = {
  shardId: string;
  coordinatorNpub: string;
  thresholdLabel: string;
  votingId: string;
  tokenCommitment: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
  createdAt: string;
  event: SimpleShardCertificate;
};

export function createSimpleShardCertificate(input: {
  coordinatorSecretKey: Uint8Array;
  thresholdLabel: string;
  votingId: string;
  tokenCommitment: string;
  shareIndex: number;
  thresholdT?: number;
  thresholdN?: number;
}) {
  const createdAt = new Date().toISOString();
  const shardId = crypto.randomUUID();

  const event = finalizeEvent({
    kind: SIMPLE_SHARD_CERTIFICATE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "simple-shard-certificate"],
      ["shard-id", shardId],
    ],
    content: JSON.stringify({
      shard_id: shardId,
      threshold_label: input.thresholdLabel,
      voting_id: input.votingId,
      token_commitment: input.tokenCommitment,
      share_index: input.shareIndex,
      threshold_t: input.thresholdT,
      threshold_n: input.thresholdN,
      created_at: createdAt,
    }),
  }, input.coordinatorSecretKey);

  return { shardId, createdAt, event };
}

export function parseSimpleShardCertificate(
  event: SimpleShardCertificate,
  expectedCoordinatorNpub?: string,
): ParsedSimpleShardCertificate | null {
  if (event.kind !== SIMPLE_SHARD_CERTIFICATE_KIND || !verifyEvent(event)) {
    return null;
  }

  try {
    const payload = JSON.parse(event.content) as {
      shard_id?: string;
      threshold_label?: string;
      voting_id?: string;
      token_commitment?: string;
      share_index?: number;
      threshold_t?: number;
      threshold_n?: number;
      created_at?: string;
    };

    if (
      !payload.shard_id
      || !payload.threshold_label
      || !payload.voting_id
      || !payload.token_commitment
      || typeof payload.share_index !== "number"
    ) {
      return null;
    }

    const coordinatorNpub = nip19.npubEncode(event.pubkey);
    if (expectedCoordinatorNpub && coordinatorNpub !== expectedCoordinatorNpub) {
      return null;
    }

    return {
      shardId: payload.shard_id,
      coordinatorNpub,
      thresholdLabel: payload.threshold_label,
      votingId: payload.voting_id,
      tokenCommitment: payload.token_commitment,
      shareIndex: payload.share_index,
      thresholdT: typeof payload.threshold_t === "number" ? payload.threshold_t : undefined,
      thresholdN: typeof payload.threshold_n === "number" ? payload.threshold_n : undefined,
      createdAt: payload.created_at ?? new Date(event.created_at * 1000).toISOString(),
      event,
    };
  } catch {
    return null;
  }
}

export async function deriveTokenIdFromSimpleShardCertificates(
  certificates: SimpleShardCertificate[],
  length = 20,
): Promise<string | null> {
  const ids = certificates
    .map((certificate) => certificate.id?.trim() ?? "")
    .filter((id) => id.length > 0)
    .sort();

  if (ids.length === 0) {
    return null;
  }

  const tokenId = await sha256Hex(ids.join(":"));
  return tokenId.slice(0, length);
}

export function getShardCertificateCoordinatorNpub(coordinatorNsec: string): string | null {
  try {
    const decoded = nip19.decode(coordinatorNsec.trim());
    if (decoded.type !== "nsec") {
      return null;
    }

    return nip19.npubEncode(getPublicKey(decoded.data as Uint8Array));
  } catch {
    return null;
  }
}
