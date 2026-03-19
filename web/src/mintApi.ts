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

export const DEFAULT_MINT_URL = "http://localhost:8787";

export function normalizeMintUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload;
}

export async function fetchEligibility(apiBaseUrl: string) {
  return fetchJson<EligibilityResponse>(`${apiBaseUrl}/api/eligibility`);
}

export async function registerEligibleNpub(apiBaseUrl: string, npub: string) {
  return fetchJson<RegistrationResponse>(`${apiBaseUrl}/api/eligibility/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ npub })
  });
}

export async function requestEligibilityChallenge(apiBaseUrl: string, npub: string) {
  return fetchJson<ChallengeResponse>(`${apiBaseUrl}/challenge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ npub })
  });
}

export async function verifyEligibilityChallenge(
  apiBaseUrl: string,
  npub: string,
  event: SignedEligibilityEvent
) {
  return fetchJson<VerificationResponse>(`${apiBaseUrl}/verify-eligibility`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ npub, event })
  });
}
