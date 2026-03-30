import { USE_MOCK } from "./config";
import type { EligibilityInfo } from "./coordinatorApi";

export type EligibilityResponse = {
  eligibleNpubs: string[];
  eligibleCount: number;
  verifiedNpubs: string[];
  verifiedCount: number;
};

export type EligibilityCheckResponse = {
  npub: string;
  allowed: boolean;
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

export async function fetchEligibility(): Promise<EligibilityResponse> {
  if (USE_MOCK) {
    return fetchJson<EligibilityResponse>("/api/eligibility");
  }

  const { fetchEligibility: fetchCoordEligibility } = await import("./coordinatorApi");
  const info: EligibilityInfo = await fetchCoordEligibility();

  return {
    eligibleNpubs: info.eligible_npubs,
    eligibleCount: info.eligible_count,
    verifiedNpubs: [],
    verifiedCount: 0
  };
}

export async function resetEligibility(): Promise<EligibilityResponse & { message: string }> {
  if (USE_MOCK) {
    return fetchJson<EligibilityResponse & { message: string }>("/api/eligibility/reset", {
      method: "POST"
    });
  }

  const current = await fetchEligibility();
  return { ...current, message: "Reset not available in production mode" };
}

export async function seedEligibility(npub: string): Promise<EligibilityResponse & { message: string }> {
  if (USE_MOCK) {
    return fetchJson<EligibilityResponse & { message: string }>("/api/eligibility/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ npub }),
    });
  }

  const current = await fetchEligibility();
  return { ...current, message: "Seeding is only available in mock mode" };
}

export async function checkEligibility(npub: string): Promise<EligibilityCheckResponse> {
  if (USE_MOCK) {
    const url = new URL("/api/eligibility/check", window.location.origin);
    url.searchParams.set("npub", npub);
    const mockResult = await fetchJson<EligibilityCheckResponse & { hasVoted: boolean }>(url.toString());
    return {
      npub: mockResult.npub,
      allowed: mockResult.allowed,
      canProceed: mockResult.canProceed,
      message: mockResult.message
    };
  }

  const { fetchEligibility: fetchCoordEligibility } = await import("./coordinatorApi");
  const info = await fetchCoordEligibility();
  const allowed = info.eligible_npubs.includes(npub);

  return {
    npub,
    allowed,
    canProceed: allowed,
    message: allowed
      ? "npub is in the eligible list"
      : "npub is not in the eligible list"
  };
}
