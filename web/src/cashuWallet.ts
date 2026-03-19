import type { CashuProof, MintInvoiceResponse } from "./cashuMintApi";

const STORAGE_KEY = "auditable-voting.cashu-proof";

export type StoredWalletBundle = {
  proof: CashuProof;
  invoice: MintInvoiceResponse;
};

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadStoredWalletBundle(): StoredWalletBundle | null {
  if (!canUseStorage()) {
    return null;
  }

  const rawValue = window.localStorage.getItem(STORAGE_KEY);

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as StoredWalletBundle;
  } catch {
    return null;
  }
}

export function loadStoredProof(): CashuProof | null {
  return loadStoredWalletBundle()?.proof ?? null;
}

export function storeWalletBundle(bundle: StoredWalletBundle) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle));
}

export function storeProof(proof: CashuProof) {
  const existingBundle = loadStoredWalletBundle();

  if (!existingBundle) {
    return;
  }

  storeWalletBundle({
    ...existingBundle,
    proof
  });
}
