import type { CashuProof } from "./cashuBlind";
import type { ElectionQuestion } from "./coordinatorApi";

const STORAGE_KEY = "auditable-voting.cashu-proof";

export type CoordinatorProof = {
  coordinatorNpub: string;
  mintUrl: string;
  proof: CashuProof;
  proofSecret: string;
};

export type StoredWalletBundle = {
  electionId: string;
  ephemeralKeypair: {
    nsec: string;
    npub: string;
  };
  coordinatorProofs: CoordinatorProof[];
  election: {
    electionId: string;
    title: string;
    questions: ElectionQuestion[];
    vote_start: number;
    vote_end: number;
    confirm_end?: number;
    mint_urls: string[];
    coordinator_npubs: string[];
    eligible_root?: string;
    eligible_count?: number;
  } | null;
  relays: string[];
  ballotEventId?: string;
  votedAt?: string;
};

const LEGACY_STORAGE_KEY = "auditable-voting.cashu-proof";

type LegacyWalletBundle = {
  proof: {
    quoteId: string;
    npub: string;
    amount: number;
    secret: string;
    signature: string;
    mintUrl: string;
    issuedAt: string;
  } | null;
  invoice: {
    quoteId: string;
    npub: string;
    invoice: string;
    amount: number;
    expiresAt: string;
    relays: string[];
    coordinatorNpub: string;
    electionId: string;
    questions: Array<{
      id: string;
      prompt: string;
      options: Array<{ value: string; label: string }>;
    }>;
  };
};

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function migrateLegacyBundle(rawValue: string): StoredWalletBundle | null {
  try {
    const legacy = JSON.parse(rawValue) as LegacyWalletBundle;

    if (legacy.invoice && legacy.invoice.coordinatorNpub) {
      return {
        electionId: legacy.invoice.electionId,
        ephemeralKeypair: { nsec: "", npub: "" },
        coordinatorProofs: legacy.proof ? [{
          coordinatorNpub: legacy.invoice.coordinatorNpub,
          mintUrl: legacy.proof.mintUrl,
          proof: {
            id: "legacy",
            amount: legacy.proof.amount,
            secret: legacy.proof.secret,
            C: legacy.proof.signature,
          },
          proofSecret: legacy.proof.secret,
        }] : [],
        election: legacy.invoice ? {
          electionId: legacy.invoice.electionId,
          title: "",
          questions: legacy.invoice.questions.map((q) => ({
            id: q.id,
            type: "choice" as const,
            prompt: q.prompt,
            options: q.options.map((o) => o.label),
            select: "single" as const,
          })),
          vote_start: 0,
          vote_end: 0,
          mint_urls: [],
          coordinator_npubs: [legacy.invoice.coordinatorNpub],
        } : null,
        relays: legacy.invoice?.relays ?? [],
      };
    }

    return null;
  } catch {
    return null;
  }
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
    const parsed = JSON.parse(rawValue) as StoredWalletBundle;

    if (parsed.electionId) {
      return parsed;
    }

    const migrated = migrateLegacyBundle(rawValue);
    if (migrated) {
      storeWalletBundle(migrated);
    }

    return migrated;
  } catch {
    const migrated = migrateLegacyBundle(rawValue);
    if (migrated) {
      storeWalletBundle(migrated);
    }

    return migrated;
  }
}

export function storeWalletBundle(bundle: StoredWalletBundle) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(bundle));
}

export function addCoordinatorProof(proof: CoordinatorProof) {
  const existingBundle = loadStoredWalletBundle();
  if (!existingBundle) return;

  const existing = existingBundle.coordinatorProofs.findIndex(
    (p) => p.coordinatorNpub === proof.coordinatorNpub,
  );

  const updated = [...existingBundle.coordinatorProofs];
  if (existing >= 0) {
    updated[existing] = proof;
  } else {
    updated.push(proof);
  }

  storeWalletBundle({ ...existingBundle, coordinatorProofs: updated });
}

export function clearStoredWalletBundle() {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}

export function storeBallotEventId(eventId: string) {
  const existingBundle = loadStoredWalletBundle();
  if (!existingBundle) return;

  storeWalletBundle({
    ...existingBundle,
    ballotEventId: eventId,
    votedAt: new Date().toISOString(),
  });
}

export function storeEphemeralKeypair(nsec: string, npub: string) {
  const existingBundle = loadStoredWalletBundle();
  if (!existingBundle) return;

  storeWalletBundle({
    ...existingBundle,
    ephemeralKeypair: { nsec, npub },
  });
}
