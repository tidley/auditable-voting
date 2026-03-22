import { COORDINATOR_URL, USE_MOCK, MINT_URL } from "./config";
import type { EligibilityResponse } from "./voterManagementApi";
import { SimplePool } from "nostr-tools";

export type ElectionQuestion = {
  id: string;
  type: "choice" | "scale" | "text";
  prompt: string;
  description?: string;
  options?: string[];
  select?: "single" | "multiple";
  min?: number;
  max?: number;
  step?: number;
  max_length?: number;
};

export type CoordinatorInfo = {
  coordinatorNpub: string;
  mintUrl: string;
  mintPublicKey: string;
  relays: string[];
  electionId: string | null;
};

export type ElectionInfo = {
  election_id: string;
  event_id: string;
  title: string;
  description: string;
  questions: ElectionQuestion[];
  start_time: number;
  end_time: number;
  mint_urls: string[];
};

export type EligibilityInfo = {
  election_id: string;
  eligible_count: number;
  eligible_npubs: string[];
};

export type TallyInfo = {
  election_id: string;
  status: "in_progress" | "closed";
  total_published_votes: number;
  total_accepted_votes: number | null;
  spent_commitment_root: string | null;
  results: Record<string, Record<string, number>>;
};

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload;
}

const MOCK_COORDINATOR_NPUB = "npub1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MOCK_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

export async function fetchCoordinatorInfo(): Promise<CoordinatorInfo> {
  if (USE_MOCK) {
    return {
      coordinatorNpub: MOCK_COORDINATOR_NPUB,
      mintUrl: MINT_URL,
      mintPublicKey: "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relays: MOCK_RELAYS,
      electionId: null
    };
  }

  return fetchJson<CoordinatorInfo>(`${COORDINATOR_URL}/info`);
}

export async function fetchElection(): Promise<ElectionInfo | null> {
  if (USE_MOCK) {
    return null;
  }

  try {
    return await fetchJson<ElectionInfo>(`${COORDINATOR_URL}/election`);
  } catch {
    return null;
  }
}

export async function fetchEligibility(): Promise<EligibilityInfo> {
  if (USE_MOCK) {
    const response = await fetch("/api/eligibility");
    const mockResponse = (await response.json()) as EligibilityResponse;
    return {
      election_id: "spring-2026-council",
      eligible_count: mockResponse.eligibleCount,
      eligible_npubs: mockResponse.eligibleNpubs
    };
  }

  return fetchJson<EligibilityInfo>(`${COORDINATOR_URL}/eligibility`);
}

export async function fetchTally(): Promise<TallyInfo | null> {
  if (USE_MOCK) {
    return null;
  }

  try {
    return await fetchJson<TallyInfo>(`${COORDINATOR_URL}/tally`);
  } catch {
    return null;
  }
}

export type ElectionSummary = {
  election_id: string;
  event_id: string;
  title: string;
  start_time: number;
  end_time: number;
  created_at: number;
};

export async function fetchElectionsFromNostr(
  coordinatorNpub: string,
  relays: string[],
): Promise<ElectionSummary[]> {
  if (!coordinatorNpub || relays.length === 0) return [];

  const publicRelays = relays.filter((r) => r.startsWith("wss://"));
  if (publicRelays.length === 0) return [];

  const pool = new SimplePool();
  try {
    const events = await Promise.race([
      pool.querySync(publicRelays, {
        kinds: [38008],
        authors: [coordinatorNpub],
        limit: 50,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Nostr query timeout")), 8000)),
    ]);

    const elections: ElectionSummary[] = events
      .map((evt) => {
        let content: Record<string, unknown> = {};
        try {
          content = JSON.parse(evt.content);
        } catch {
          return null;
        }

        const electionId =
          (content.election_id as string) ??
          evt.tags.find((t) => t[0] === "e")?.[1] ??
          "";

        return {
          election_id: electionId,
          event_id: evt.id,
          title: (content.title as string) ?? "Untitled election",
          start_time: (content.start_time as number) ?? 0,
          end_time: (content.end_time as number) ?? 0,
          created_at: evt.created_at,
        };
      })
      .filter((e): e is ElectionSummary => e !== null && !!e.election_id)
      .sort((a, b) => b.created_at - a.created_at);

    return elections;
  } catch {
    return [];
  } finally {
    pool.close(publicRelays);
  }
}
