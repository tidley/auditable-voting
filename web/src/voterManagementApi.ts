export type EligibilityResponse = {
  eligibleNpubs: string[];
  eligibleCount: number;
  verifiedNpubs: string[];
  verifiedCount: number;
};

export type RegistrationResponse = EligibilityResponse & {
  added: boolean;
  message: string;
  npub: string;
};

export type ChallengeResponse = {
  challenge: string;
  npub: string;
  expiresAt: string;
};

export type VerificationResponse = {
  verified: boolean;
  npub: string;
  message: string;
  issuanceReady: boolean;
  verifiedAt: string;
};

export type SignedEligibilityEvent = {
  id: string;
  sig: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags: string[][];
};

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload;
}

export async function fetchEligibility() {
  return fetchJson<EligibilityResponse>("/api/eligibility");
}

export async function registerEligibleNpub(npub: string) {
  return fetchJson<RegistrationResponse>("/api/eligibility/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ npub })
  });
}

export async function requestEligibilityChallenge(npub: string) {
  return fetchJson<ChallengeResponse>("/challenge", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ npub })
  });
}

export async function verifyEligibilityChallenge(npub: string, event: SignedEligibilityEvent) {
  return fetchJson<VerificationResponse>("/verify-eligibility", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ npub, event })
  });
}
