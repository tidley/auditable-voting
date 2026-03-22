export type BallotQuestion = {
  id: string;
  type: "choice" | "scale" | "text";
  prompt: string;
  options?: Array<{ value: string; label: string }>;
  rawOptions?: string[];
  select?: "single" | "multiple";
  min?: number;
  max?: number;
  step?: number;
  max_length?: number;
};

export type MintInvoiceResponse = {
  quoteId: string;
  npub: string;
  invoice: string;
  amount: number;
  expiresAt: string;
  relays: string[];
  coordinatorNpub: string;
  electionId: string;
  questions: BallotQuestion[];
};

export type CashuProof = {
  quoteId: string;
  npub: string;
  amount: number;
  secret: string;
  signature: string;
  mintUrl: string;
  issuedAt: string;
};

export type RelayPublishResult = {
  relay: string;
  success: boolean;
  error?: string;
};

export type ClaimDebugPayload = {
  npub?: string;
  coordinatorNpub?: string;
  mintApiUrl?: string;
  relays?: string[];
  quoteId?: string;
  invoice?: string;
  event?: {
    id?: string;
    pubkey?: string;
    kind?: number;
    created_at?: number;
    content?: string;
    tags?: string[][];
    sig?: string;
  };
  publishResult?: {
    eventId?: string;
    successes?: number;
    failures?: number;
    relayResults?: Array<{
      relay?: string;
      success?: boolean;
      error?: string;
    }>;
  };
};

export type BallotDebugPayload = {
  electionId?: string;
  proofHash?: string;
  relays?: string[];
  event?: {
    id?: string;
    pubkey?: string;
    kind?: number;
    created_at?: number;
    content?: string;
    tags?: string[][];
    sig?: string;
  };
  publishResult?: {
    eventId?: string;
    ballotNpub?: string;
    successes?: number;
    failures?: number;
    relayResults?: Array<{
      relay?: string;
      success?: boolean;
      error?: string;
    }>;
  };
};

export type ProofStatusResponse =
  | {
      status: "pending";
      quoteId: string;
      pollAfterMs: number;
    }
  | {
      status: "ready";
      quoteId: string;
      proof: CashuProof;
    };

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload;
}

export async function requestMintInvoice(mintApiUrl: string) {
  return fetchJson<MintInvoiceResponse>(`${mintApiUrl}/invoice`);
}

export async function fetchMintProof(mintApiUrl: string, quoteId: string) {
  return fetchJson<ProofStatusResponse>(`${mintApiUrl}/proof/${quoteId}`);
}

export async function logClaimDebug(payload: ClaimDebugPayload) {
  return fetchJson<{ ok: true }>("/api/debug/claim-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function logBallotDebug(payload: BallotDebugPayload) {
  return fetchJson<{ ok: true }>("/api/debug/ballot-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}
