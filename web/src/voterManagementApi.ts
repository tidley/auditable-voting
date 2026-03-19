export type EligibilityResponse = {
  eligibleNpubs: string[];
  eligibleCount: number;
  verifiedNpubs: string[];
  verifiedCount: number;
};

export type EligibilityCheckResponse = {
  npub: string;
  allowed: boolean;
  hasVoted: boolean;
  canProceed: boolean;
  message: string;
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

export async function resetEligibility() {
  return fetchJson<EligibilityResponse & { message: string }>("/api/eligibility/reset", {
    method: "POST"
  });
}

export async function checkEligibility(npub: string) {
  const url = new URL("/api/eligibility/check", window.location.origin);
  url.searchParams.set("npub", npub);
  return fetchJson<EligibilityCheckResponse>(url.toString());
}
