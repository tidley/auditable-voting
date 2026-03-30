import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

export type DemoIdentity = {
  nsec: string;
  npub: string;
  pubkey: string;
};

export function createDemoIdentity(): DemoIdentity {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);

  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(pubkey),
    pubkey,
  };
}
