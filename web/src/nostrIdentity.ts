import { finalizeEvent, getPublicKey, nip19, SimplePool } from "nostr-tools";
import type { MintInvoiceResponse, RelayPublishResult } from "./cashuMintApi";

export const CASHU_ISSUANCE_CLAIM_KIND = 38010;

export function isValidNpub(value: string) {
  try {
    const decoded = nip19.decode(value.trim());
    return decoded.type === "npub";
  } catch {
    return false;
  }
}

export function decodeNsec(value: string): Uint8Array | null {
  try {
    const decoded = nip19.decode(value.trim());
    return decoded.type === "nsec" ? decoded.data : null;
  } catch {
    return null;
  }
}

export function deriveNpubFromNsec(value: string): string | null {
  const secretKey = decodeNsec(value);

  if (!secretKey) {
    return null;
  }

  return nip19.npubEncode(getPublicKey(secretKey));
}

function decodeNpubToHex(value: string): string {
  const decoded = nip19.decode(value.trim());

  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }

  return decoded.data;
}

export function createCashuClaimEvent(
  nsec: string,
  npub: string,
  invoice: MintInvoiceResponse,
  mintApiUrl: string
){
  const secretKey = decodeNsec(nsec);

  if (!secretKey) {
    throw new Error("Enter a valid nsec to sign the invoice claim.");
  }

  return finalizeEvent(
    {
      kind: CASHU_ISSUANCE_CLAIM_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "cashu-issuance"],
        ["p", decodeNpubToHex(invoice.coordinatorNpub)],
        ["quote", invoice.quoteId],
        ["invoice", invoice.invoice],
        ["mint", mintApiUrl],
        ["amount", String(invoice.amount)]
      ],
      content: JSON.stringify({
        action: "cashu_invoice_claim",
        quote_id: invoice.quoteId,
        invoice: invoice.invoice,
        npub,
        coordinator_npub: invoice.coordinatorNpub
      })
    },
    secretKey
  );
}

export async function publishCashuClaim(relays: string[], event: ReturnType<typeof createCashuClaimEvent>) {
  const pool = new SimplePool();

  try {
    const results = await Promise.allSettled(pool.publish(relays, event, { maxWait: 4000 }));
    const relayResults: RelayPublishResult[] = results.map((result, index) => (
      result.status === "fulfilled"
        ? { relay: relays[index], success: true }
        : {
            relay: relays[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          }
    ));

    return {
      eventId: event.id,
      successes: relayResults.filter((result) => result.success).length,
      failures: relayResults.filter((result) => !result.success).length,
      relayResults
    };
  } finally {
    pool.destroy();
  }
}

export function getNostrEventVerificationUrl(input: {
  eventId: string;
  relays?: string[];
  author?: string;
  kind?: number;
}) {
  const nevent = nip19.neventEncode({
    id: input.eventId,
    relays: input.relays,
    author: input.author,
    kind: input.kind
  });

  return `https://njump.me/${nevent}`;
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}
