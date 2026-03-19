import { randomBytes } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { nip19, verifyEvent } from "nostr-tools";

export type EligibilitySnapshot = {
  eligibleNpubs: string[];
  eligibleCount: number;
  verifiedNpubs: string[];
  verifiedCount: number;
};

type RegistrationResult = {
  added: boolean;
  npub: string;
  snapshot: EligibilitySnapshot;
};

type ChallengeRecord = {
  npub: string;
  expiresAt: number;
};

type ChallengeResult = {
  challenge: string;
  npub: string;
  expiresAt: string;
};

type VerificationEvent = {
  id: string;
  sig: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
};

type VerificationResult = {
  verified: true;
  npub: string;
  message: string;
  issuanceReady: true;
  verifiedAt: string;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const ELIGIBILITY_VERIFICATION_KIND = 22242;

class DemoMint {
  private readonly eligibleNpubs = new Set<string>();
  private readonly outstandingChallenges = new Map<string, ChallengeRecord>();
  private readonly verifiedNpubs = new Map<string, number>();

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

  registerEligibleNpub(npub: string): RegistrationResult {
    const normalizedNpub = validateNpub(npub);
    const added = !this.eligibleNpubs.has(normalizedNpub);

    if (added) {
      this.eligibleNpubs.add(normalizedNpub);
      console.log(`[server] registered npub: ${normalizedNpub}`);
      console.log(`[server] eligible_count = ${this.eligibleNpubs.size}`);
    } else {
      console.log(`[server] duplicate registration ignored: ${normalizedNpub}`);
      console.log(`[server] eligible_count = ${this.eligibleNpubs.size}`);
    }

    return {
      added,
      npub: normalizedNpub,
      snapshot: this.snapshot()
    };
  }

  issueChallenge(npub: string): ChallengeResult {
    const normalizedNpub = validateNpub(npub);

    if (!this.eligibleNpubs.has(normalizedNpub)) {
      throw new Error("npub is not in the eligible list");
    }

    this.pruneExpiredChallenges();

    const challenge = randomBytes(32).toString("hex");
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;

    this.outstandingChallenges.set(challenge, {
      npub: normalizedNpub,
      expiresAt
    });

    console.log(`[server] issued challenge for npub: ${normalizedNpub}`);

    return {
      challenge,
      npub: normalizedNpub,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  verifyEligibility(npub: string, event: VerificationEvent): VerificationResult {
    const normalizedNpub = validateNpub(npub);

    if (!event || typeof event !== "object") {
      throw new Error("Signed event is required");
    }

    if (!this.eligibleNpubs.has(normalizedNpub)) {
      throw new Error("npub is not in the eligible list");
    }

    if (event.kind !== ELIGIBILITY_VERIFICATION_KIND) {
      throw new Error(`Expected eligibility verification event kind ${ELIGIBILITY_VERIFICATION_KIND}`);
    }

    if (!Array.isArray(event.tags)) {
      throw new Error("Signed event is missing tags");
    }

    const challenge = this.getChallengeTagValue(event.tags);
    const challengeRecord = this.outstandingChallenges.get(challenge);

    if (!challengeRecord) {
      throw new Error("Challenge not found or already used");
    }

    if (challengeRecord.expiresAt < Date.now()) {
      this.outstandingChallenges.delete(challenge);
      throw new Error("Challenge expired");
    }

    if (challengeRecord.npub !== normalizedNpub) {
      throw new Error("Challenge was issued for a different npub");
    }

    if (event.pubkey !== decodeNpubToHex(normalizedNpub)) {
      throw new Error("Signed event pubkey does not match npub");
    }

    if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
      throw new Error("Invalid signed event");
    }

    this.outstandingChallenges.delete(challenge);

    const verifiedAt = Date.now();
    this.verifiedNpubs.set(normalizedNpub, verifiedAt);

    console.log(`[server] eligibility verified for npub: ${normalizedNpub}`);
    console.log(`[server] blind issuance unlocked for npub: ${normalizedNpub}`);

    return {
      verified: true,
      npub: normalizedNpub,
      message: "Eligibility verified. Blind issuance can proceed.",
      issuanceReady: true,
      verifiedAt: new Date(verifiedAt).toISOString()
    };
  }

  private getChallengeTagValue(tags: string[][]): string {
    const challengeTag = tags.find((tag) => tag[0] === "challenge" && typeof tag[1] === "string");

    if (!challengeTag?.[1]) {
      throw new Error("Signed event is missing the challenge tag");
    }

    return challengeTag[1];
  }

  private pruneExpiredChallenges() {
    const now = Date.now();

    for (const [challenge, record] of this.outstandingChallenges.entries()) {
      if (record.expiresAt < now) {
        this.outstandingChallenges.delete(challenge);
      }
    }
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

function decodeNpubToHex(npub: string): string {
  const decoded = nip19.decode(npub);

  if (decoded.type !== "npub") {
    throw new Error("Expected an npub value");
  }

  return decoded.data;
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

  console.log("[server] phase 1 eligibility setup ready");
  console.log("[server] eligible_count = 0");

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

      if (request.method === "GET" && url.pathname === "/api/eligibility") {
        writeJson(response, 200, mint.snapshot());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/eligibility/register") {
        const body = await readJsonBody(request) as { npub?: string };
        const result = mint.registerEligibleNpub(body.npub ?? "");

        writeJson(response, 200, {
          message: result.added ? "Eligible npub registered" : "npub already registered",
          npub: result.npub,
          added: result.added,
          ...result.snapshot
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/challenge") {
        const body = await readJsonBody(request) as { npub?: string };
        const result = mint.issueChallenge(body.npub ?? "");

        writeJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/verify-eligibility") {
        const body = await readJsonBody(request) as { npub?: string; event?: VerificationEvent };
        const result = mint.verifyEligibility(body.npub ?? "", body.event as VerificationEvent);

        writeJson(response, 200, result);
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
  console.log("[server] POST /api/eligibility/register");
  console.log("[server] POST /challenge");
  console.log("[server] POST /verify-eligibility");

  return server;
}
