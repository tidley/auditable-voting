import { randomBytes } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { getPublicKey, nip19 } from "nostr-tools";
import { ALLOWED_NPUBS } from "./voterConfig.js";

export type EligibilitySnapshot = {
  eligibleNpubs: string[];
  eligibleCount: number;
  verifiedNpubs: string[];
  verifiedCount: number;
};

type EligibilityCheckResult = {
  npub: string;
  allowed: boolean;
  hasVoted: boolean;
  canProceed: boolean;
  message: string;
};

type VoteStatusResult = {
  npub: string;
  hasVoted: boolean;
};

type MockMintInvoice = {
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
    options: Array<{
      value: string;
      label: string;
    }>;
  }>;
};

type MockCashuProof = {
  quoteId: string;
  npub: string;
  amount: number;
  secret: string;
  signature: string;
  mintUrl: string;
  issuedAt: string;
};

type MockProofResponse =
  | {
      status: "pending";
      quoteId: string;
      pollAfterMs: number;
    }
  | {
      status: "ready";
      quoteId: string;
      proof: MockCashuProof;
    };

type MockQuoteRecord = {
  quoteId: string;
  npub: string;
  invoice: string;
  amount: number;
  expiresAt: number;
  readyAt: number;
  proof: MockCashuProof;
};

type ClaimDebugPayload = {
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

type BallotDebugPayload = {
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

const MOCK_QUOTE_TTL_MS = 10 * 60 * 1000;
const MOCK_PROOF_READY_MS = 4000;
const DEFAULT_MOCK_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net"
];
const DEFAULT_COORDINATOR_NPUB = nip19.npubEncode(
  getPublicKey(Uint8Array.from(Array.from({ length: 32 }, () => 7)))
);
const DEFAULT_ELECTION_ID = "spring-2026-council";
const DEFAULT_BALLOT_QUESTIONS = [
  {
    id: "funding_priority",
    prompt: "Which area should receive the first round of funding?",
    options: [
      { value: "community-grants", label: "Community grants" },
      { value: "security-audits", label: "Security audits" },
      { value: "education-programs", label: "Education programs" }
    ]
  },
  {
    id: "audit_policy",
    prompt: "How often should published results receive an independent audit?",
    options: [
      { value: "every-election", label: "Every election" },
      { value: "annual-review", label: "Annual review" },
      { value: "only-disputes", label: "Only on disputes" }
    ]
  }
];

class DemoMint {
  private readonly eligibleNpubs = new Set<string>(ALLOWED_NPUBS);
  private readonly verifiedNpubs = new Map<string, number>();
  private currentNpub: string | null = null;

  snapshot(): EligibilitySnapshot {
    const eligibleNpubs = [...this.eligibleNpubs].sort();
    const verifiedNpubs = [...this.verifiedNpubs.keys()].sort();

    return {
      eligibleNpubs,
      eligibleCount: eligibleNpubs.length,
      verifiedNpubs,
      verifiedCount: verifiedNpubs.length
    };
  }

  hasAllowedNpub(npub: string): boolean {
    return this.eligibleNpubs.has(validateNpub(npub));
  }

  setCurrentEligibleNpub(npub: string) {
    this.currentNpub = this.ensureEligibleNpub(npub);
    console.log(`[server] current eligible npub selected: ${this.currentNpub}`);
  }

  ensureEligibleNpub(npub: string): string {
    const normalizedNpub = validateNpub(npub);

    if (!this.eligibleNpubs.has(normalizedNpub)) {
      throw new Error("npub is not in the eligible list");
    }

    return normalizedNpub;
  }

  getCurrentEligibleNpub(): string {
    if (!this.currentNpub) {
      throw new Error("No eligible npub has passed step 1 yet");
    }

    return this.currentNpub;
  }

  markProofIssued(npub: string) {
    const normalizedNpub = this.ensureEligibleNpub(npub);
    const verifiedAt = Date.now();
    const wasAlreadyVerified = this.verifiedNpubs.has(normalizedNpub);
    this.verifiedNpubs.set(normalizedNpub, verifiedAt);

    console.log(`[server] proof issued for npub: ${normalizedNpub}`);
    console.log(`[server] proof verification status = ${wasAlreadyVerified ? "existing" : "new"}`);
    console.log(`[server] verified_count = ${this.verifiedNpubs.size}`);
  }

  resetVerifiedStatuses() {
    this.verifiedNpubs.clear();
    this.currentNpub = null;
    console.log("[server] verified statuses reset to pending");
    console.log(`[server] verified_count = ${this.verifiedNpubs.size}`);
    return this.snapshot();
  }
}

class MockMintService {
  private readonly quotes = new Map<string, MockQuoteRecord>();

  constructor(private readonly voterRegistry: DemoMint) {}

  issueInvoice(baseUrl: string): MockMintInvoice {
    this.pruneExpiredQuotes();

    const normalizedNpub = this.voterRegistry.getCurrentEligibleNpub();

    const quoteId = randomBytes(16).toString("hex");
    const expiresAt = Date.now() + MOCK_QUOTE_TTL_MS;
    const readyAt = Date.now() + MOCK_PROOF_READY_MS;
    const invoice = `lnbc10u1p${quoteId}`;
    const proof: MockCashuProof = {
      quoteId,
      npub: normalizedNpub,
      amount: 1,
      secret: randomBytes(32).toString("hex"),
      signature: randomBytes(64).toString("hex"),
      mintUrl: baseUrl,
      issuedAt: new Date(readyAt).toISOString()
    };

    this.quotes.set(quoteId, {
      quoteId,
      npub: normalizedNpub,
      invoice,
      amount: 1,
      expiresAt,
      readyAt,
      proof
    });

    console.log(`[server] mock invoice issued: ${quoteId} for ${normalizedNpub}`);
    console.log("[server] mock invoice details:");
    console.log(JSON.stringify({
      quoteId,
      npub: normalizedNpub,
      invoice,
      amount: 1,
      expiresAt: new Date(expiresAt).toISOString(),
      relays: DEFAULT_MOCK_RELAYS,
      coordinatorNpub: DEFAULT_COORDINATOR_NPUB,
      electionId: DEFAULT_ELECTION_ID,
      questions: DEFAULT_BALLOT_QUESTIONS,
      mintUrl: baseUrl
    }, null, 2));

    return {
      quoteId,
      npub: normalizedNpub,
      invoice,
      amount: 1,
      expiresAt: new Date(expiresAt).toISOString(),
      relays: DEFAULT_MOCK_RELAYS,
      coordinatorNpub: DEFAULT_COORDINATOR_NPUB,
      electionId: DEFAULT_ELECTION_ID,
      questions: DEFAULT_BALLOT_QUESTIONS
    };
  }

  getProof(quoteId: string): MockProofResponse {
    this.pruneExpiredQuotes();

    const record = this.quotes.get(quoteId);

    if (!record) {
      throw new Error("Quote not found or expired");
    }

    if (Date.now() < record.readyAt) {
      return {
        status: "pending",
        quoteId,
        pollAfterMs: 2000
      };
    }

    this.voterRegistry.markProofIssued(record.npub);
    console.log(`[server] mock proof ready: ${quoteId}`);
    console.log("[server] mock proof details:");
    console.log(JSON.stringify(record.proof, null, 2));

    return {
      status: "ready",
      quoteId,
      proof: record.proof
    };
  }

  private pruneExpiredQuotes() {
    const now = Date.now();

    for (const [quoteId, record] of this.quotes.entries()) {
      if (record.expiresAt < now) {
        this.quotes.delete(quoteId);
      }
    }
  }
}

class MockVoteStatusService {
  getVoteStatus(npub: string): VoteStatusResult {
    const normalizedNpub = validateNpub(npub);

    return {
      npub: normalizedNpub,
      hasVoted: false
    };
  }
}

function validateNpub(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("npub is required");
  }

  const decoded = nip19.decode(trimmed);

  if (decoded.type !== "npub") {
    throw new Error("Expected an npub value");
  }

  return trimmed;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json"
  });

  response.end(JSON.stringify(payload));
}

function logClaimDebug(payload: ClaimDebugPayload) {
  console.log("[server] cashu claim publish details:");
  console.log(JSON.stringify(payload, null, 2));

  const failedRelays = payload.publishResult?.relayResults?.filter((result) => !result.success);

  if (failedRelays && failedRelays.length > 0) {
    console.log("[server] cashu claim publish errors:");
    console.log(JSON.stringify(failedRelays, null, 2));
  }
}

function logBallotDebug(payload: BallotDebugPayload) {
  console.log("[server] ballot publish details:");
  console.log(JSON.stringify(payload, null, 2));

  const failedRelays = payload.publishResult?.relayResults?.filter((result) => !result.success);

  if (failedRelays && failedRelays.length > 0) {
    console.log("[server] ballot publish errors:");
    console.log(JSON.stringify(failedRelays, null, 2));
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startVoterServer(port = 8787) {
  const mint = new DemoMint();
  const mockMintService = new MockMintService(mint);
  const mockVoteStatusService = new MockVoteStatusService();

  console.log("[server] phase 1,2 eligibility setup ready");
  console.log(`[server] eligible_count = ${ALLOWED_NPUBS.length}`);

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Origin": "*"
        });
        response.end();
        return;
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `localhost:${port}`}`);
      const baseUrl = `${url.protocol}//${url.host}/mock-mint`;

      if (request.method === "GET" && url.pathname === "/api/eligibility") {
        writeJson(response, 200, mint.snapshot());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/vote-status") {
        const npub = url.searchParams.get("npub") ?? "";
        const result = mockVoteStatusService.getVoteStatus(npub);

        console.log(`[server] mock vote status check for ${result.npub}: hasVoted=${result.hasVoted}`);
        console.log("[server] mock vote status details:");
        console.log(JSON.stringify(result, null, 2));
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/eligibility/check") {
        const npub = validateNpub(url.searchParams.get("npub") ?? "");
        const allowed = mint.hasAllowedNpub(npub);
        const voteStatus = mockVoteStatusService.getVoteStatus(npub);
        const canProceed = allowed && !voteStatus.hasVoted;

        if (canProceed) {
          mint.setCurrentEligibleNpub(npub);
        }

        const result: EligibilityCheckResult = {
          npub,
          allowed,
          hasVoted: voteStatus.hasVoted,
          canProceed,
          message: canProceed
            ? "npub is allowed and has not voted yet"
            : allowed
              ? "npub has already voted"
              : "npub is not in the allowed list"
        };

        console.log("[server] eligibility check result:");
        console.log(JSON.stringify(result, null, 2));
        writeJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/eligibility/reset") {
        const snapshot = mint.resetVerifiedStatuses();
        writeJson(response, 200, {
          message: "All allowed npubs reset to pending",
          ...snapshot
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/mock-mint/invoice") {
        writeJson(response, 200, mockMintService.issueInvoice(baseUrl));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/debug/claim-log") {
        const body = await readJsonBody(request) as ClaimDebugPayload;
        logClaimDebug(body);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/debug/ballot-log") {
        const body = await readJsonBody(request) as BallotDebugPayload;
        logBallotDebug(body);
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/mock-mint/proof/")) {
        const quoteId = url.pathname.replace("/mock-mint/proof/", "").trim();
        writeJson(response, 200, mockMintService.getProof(quoteId));
        return;
      }

      writeJson(response, 404, {
        error: "Not found"
      });
    } catch (error) {
      writeJson(response, 400, {
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, resolve);
  });

  console.log(`[server] listening on http://localhost:${port}`);
  console.log("[server] GET /api/eligibility");
  console.log("[server] GET /api/eligibility/check?npub=");
  console.log("[server] POST /api/eligibility/reset");
  console.log("[server] GET /api/vote-status?npub=");
  console.log("[server] POST /api/debug/claim-log");
  console.log("[server] POST /api/debug/ballot-log");
  console.log("[server] GET /mock-mint/invoice");
  console.log("[server] GET /mock-mint/proof/:quoteId");

  return server;
}
