import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import type { MintInvoiceResponse } from "./cashuMintApi";

export type GeneratedIdentity = {
  npub: string;
  nsec: string;
};

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

export function createGeneratedIdentity(): GeneratedIdentity {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);

  return {
    npub: nip19.npubEncode(publicKey),
    nsec: nip19.nsecEncode(secretKey)
  };
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
        ["p", invoice.coordinatorNpub],
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

    return {
      eventId: event.id,
      successes: results.filter((result) => result.status === "fulfilled").length,
      failures: results.filter((result) => result.status === "rejected").length
    };
  } finally {
    pool.destroy();
  }
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}
