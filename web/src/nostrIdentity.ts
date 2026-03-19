import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { ChallengeResponse, SignedEligibilityEvent } from "./voterManagementApi";

export type GeneratedIdentity = {
  npub: string;
  nsec: string;
};

export const ELIGIBILITY_VERIFICATION_KIND = 22242;

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

export function createEligibilityVerificationEvent(
  nsec: string,
  challenge: ChallengeResponse,
  mintApiUrl: string
): SignedEligibilityEvent {
  const secretKey = decodeNsec(nsec);

  if (!secretKey) {
    throw new Error("Enter a valid nsec to sign the challenge.");
  }

  return finalizeEvent(
    {
      kind: ELIGIBILITY_VERIFICATION_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["challenge", challenge.challenge],
        ["mint", mintApiUrl],
        ["purpose", "eligibility_verification"]
      ],
      content: JSON.stringify({
        action: "eligibility_verification",
        challenge: challenge.challenge,
        npub: challenge.npub
      })
    },
    secretKey
  );
}

export function formatDateTime(value: string) {
  return new Date(value).toLocaleString();
}
