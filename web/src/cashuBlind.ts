import { CashuWallet, getEncodedToken } from "@cashu/cashu-ts";
// @ts-expect-error CashuMint exported at runtime but tsc can't resolve .js->.d.ts
import { CashuMint } from "@cashu/cashu-ts";
import { USE_MOCK } from "./config";

export type CashuProof = {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r?: string };
  witness?: string;
};

export type MintResult = {
  proofs: CashuProof[];
  quote: string;
  serializedToken?: string;
};

export async function requestQuoteAndMint(mintUrl: string, quoteId: string): Promise<MintResult> {
  if (USE_MOCK) {
    console.log("[mint] mock mode: returning proof for quote", quoteId);
    return {
      proofs: [{
        id: "mock_keyset_id",
        amount: 1,
        secret: "mock_secret_" + Math.random().toString(36).slice(2),
        C: "mock_signature_" + Math.random().toString(36).slice(2),
      }],
      quote: quoteId,
    };
  }

  console.log("[mint] minting proofs against approved quote:", quoteId, "on mint:", mintUrl);

  const keysResp = await fetch(`${mintUrl}/v1/keys`);
  const keysData = await keysResp.json();
  const wallet = new CashuWallet(new CashuMint(mintUrl), {
    unit: "sat",
    keys: keysData.keysets,
    keysets: keysData.keysets,
  });

  const proofs = await wallet.mintProofs(1, quoteId);

  const serialized = getEncodedToken({ mint: mintUrl, proofs });

  return {
    proofs: proofs as unknown as CashuProof[],
    quote: quoteId,
    serializedToken: serialized,
  };
}
