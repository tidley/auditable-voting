import type { CashuProof } from "./cashuBlind";
import type { ElectionQuestion } from "./coordinatorApi";

const STORAGE_KEY = "auditable-voting.cashu-proof";

export type StoredWalletBundle = {
  proof: CashuProof | null;
  election: {
    electionId: string;
    title: string;
    questions: ElectionQuestion[];
    start_time: number;
    end_time: number;
    mint_urls: string[];
  } | null;
  quote: {
    quoteId: string;
    bolt11: string;
  } | null;
  coordinatorNpub: string;
  mintUrl: string;
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
        proof: legacy.proof ? {
          id: "legacy",
          amount: legacy.proof.amount,
          secret: legacy.proof.secret,
          C: legacy.proof.signature
        } : null,
        election: legacy.invoice ? {
          electionId: legacy.invoice.electionId,
          title: "",
          questions: legacy.invoice.questions.map((q) => ({
            id: q.id,
            type: "choice" as const,
            prompt: q.prompt,
            options: q.options.map((o) => o.label),
            select: "single" as const
          })),
          start_time: 0,
          end_time: 0,
          mint_urls: []
        } : null,
        quote: legacy.invoice ? {
          quoteId: legacy.invoice.quoteId,
          bolt11: legacy.invoice.invoice
        } : null,
        coordinatorNpub: legacy.invoice.coordinatorNpub,
        mintUrl: legacy.invoice ? `http://localhost:8787/mock-mint` : "",
        relays: legacy.invoice?.relays ?? []
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

    if (parsed.coordinatorNpub) {
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

export function clearStoredWalletBundle() {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
}

export function storeBallotEventId(eventId: string) {
  const existingBundle = loadStoredWalletBundle();

  if (!existingBundle) {
    return;
  }

  storeWalletBundle({
    ...existingBundle,
    ballotEventId: eventId,
    votedAt: new Date().toISOString()
  });
}
