import { USE_MOCK, MINT_URL } from "./config";
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
  vote_start: number;
  vote_end: number;
  confirm_end?: number;
  mint_urls: string[];
  coordinator_npubs: string[];
  eligible_root?: string;
  eligible_count?: number;
  eligible_url?: string;
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

export type PerCoordinatorTally = {
  coordinatorNpub: string;
  httpApi: string;
  tally: TallyInfo | null;
  result: FinalResultInfo | null;
};

export type AuditResult = {
  coordinatorNpub: string;
  tally: number;
  confirmations: number;
  fakeConfirmations: number;
  canonicalCount: number;
  flags: string[];
};

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    cache: "no-store",
  });
  const payload = await response.json() as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Request failed");
  }

  return payload;
}

const MOCK_COORDINATOR_NPUB = "npub1nzwqkakt2cuhrlwfhme3asrvx4s0xfyadm57tkpu2a39t9hqtahs7fsn89";
const MOCK_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const MOCK_ELECTION_ID = "spring-2026-council";
const MOCK_ELECTION_EVENT_ID = "a".repeat(64);
const MOCK_ELECTION_QUESTIONS: ElectionQuestion[] = [
  {
    id: "proposal_approval",
    type: "choice",
    prompt: "Should the proposal pass?",
    options: ["Yes", "No"],
    select: "single",
  },
];

export async function fetchCoordinatorInfo(httpApi?: string): Promise<CoordinatorInfo> {
  if (USE_MOCK) {
    return {
      coordinatorNpub: MOCK_COORDINATOR_NPUB,
      mintUrl: MINT_URL,
      mintPublicKey: "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      relays: MOCK_RELAYS,
      electionId: null
    };
  }

  const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}/info`;
  return fetchJson<CoordinatorInfo>(`${url}/info`);
}

export async function fetchElection(httpApi?: string): Promise<ElectionInfo | null> {
  if (USE_MOCK) {
    const now = Math.floor(Date.now() / 1000);
    return {
      election_id: MOCK_ELECTION_ID,
      event_id: MOCK_ELECTION_EVENT_ID,
      title: "Mock election",
      description: "Local demo election used for copy-paste testing.",
      questions: MOCK_ELECTION_QUESTIONS,
      vote_start: now - 7200,
      vote_end: now - 300,
      confirm_end: now + 3600,
      mint_urls: [MINT_URL],
      coordinator_npubs: [MOCK_COORDINATOR_NPUB],
      eligible_root: "",
      eligible_count: 0,
      eligible_url: "",
    };
  }

  try {
    const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
    return await fetchJson<ElectionInfo>(`${url}/election`);
  } catch {
    return null;
  }
}

export async function fetchEligibility(httpApi?: string): Promise<EligibilityInfo> {
  if (USE_MOCK) {
    const response = await fetch("/api/eligibility");
    const mockResponse = (await response.json()) as EligibilityResponse;
    return {
      election_id: "spring-2026-council",
      eligible_count: mockResponse.eligibleCount,
      eligible_npubs: mockResponse.eligibleNpubs
    };
  }

  const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
  return fetchJson<EligibilityInfo>(`${url}/eligibility`);
}

export async function fetchTally(httpApi?: string): Promise<TallyInfo | null> {
  if (USE_MOCK) {
    try {
      return await fetchJson<TallyInfo>("/api/tally");
    } catch {
      return {
        election_id: MOCK_ELECTION_ID,
        status: "in_progress",
        total_published_votes: 0,
        total_accepted_votes: 0,
        spent_commitment_root: null,
        results: {},
      };
    }
  }

  try {
    const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
    return await fetchJson<TallyInfo>(`${url}/tally`);
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
  coordinatorNpubs: string[],
  relays: string[],
): Promise<ElectionSummary[]> {
  if (coordinatorNpubs.length === 0 || relays.length === 0) return [];

  const publicRelays = relays.filter((r) => r.startsWith("wss://"));
  if (publicRelays.length === 0) return [];

  const pool = new SimplePool();
  try {
    const events = await Promise.race([
      pool.querySync(publicRelays, {
        kinds: [38008],
        authors: coordinatorNpubs,
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
          start_time: (content.vote_start as number) ?? (content.start_time as number) ?? 0,
          end_time: (content.vote_end as number) ?? (content.end_time as number) ?? 0,
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

export async function checkVoteAccepted(
  ballotEventId: string,
  coordinatorNpubs: string[],
  relays: string[],
): Promise<{ npub: string; accepted: boolean }[]> {
  if (!ballotEventId || coordinatorNpubs.length === 0 || relays.length === 0) return [];

  const publicRelays = relays.filter((r) => r.startsWith("wss://"));
  if (publicRelays.length === 0) return [];

  const pool = new SimplePool();
  try {
    const events = await Promise.race([
      pool.querySync(publicRelays, {
        kinds: [38002],
        authors: coordinatorNpubs,
        "#e": [ballotEventId],
        limit: 10,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Nostr query timeout")), 8000)),
    ]);

    const acceptedBy = new Set(events.map((e) => e.pubkey));

    return coordinatorNpubs.map((npub) => ({
      npub,
      accepted: acceptedBy.has(npub),
    }));
  } catch {
    return coordinatorNpubs.map((npub) => ({ npub, accepted: false }));
  } finally {
    pool.close(publicRelays);
  }
}

export type IssuanceStatusInfo = {
  eligible: boolean;
  issued: boolean;
};

export type IssuanceStatusResponse = {
  election_id: string;
  voters: Record<string, IssuanceStatusInfo>;
};

export type IssuanceStartResponse = {
  request_id: string;
  status_url: string;
  status: "pending" | "issued" | "ineligible" | "already_issued" | "timeout";
};

export type IssuanceAwaitResponse = {
  request_id?: string;
  status: "pending" | "issued" | "ineligible" | "already_issued" | "timeout";
  issued: boolean;
  quote_state?: "UNPAID" | "PAID" | "ISSUED";
  retry_after_ms?: number;
  message?: string;
};

export async function fetchIssuanceStatus(httpApi?: string): Promise<IssuanceStatusResponse | null> {
  if (USE_MOCK) {
    const response = await fetch("/api/eligibility");
    const mockResponse = (await response.json()) as EligibilityResponse;
    const voters: Record<string, { eligible: boolean; issued: boolean }> = {};
    for (const npub of mockResponse.eligibleNpubs) {
      voters[npub] = {
        eligible: true,
        issued: mockResponse.verifiedNpubs.includes(npub),
      };
    }

    return {
      election_id: MOCK_ELECTION_ID,
      voters,
    };
  }

  try {
    const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
    return await fetchJson<IssuanceStatusResponse>(`${url}/issuance-status`);
  } catch {
    return null;
  }
}

export async function startIssuanceTracking(input: {
  npub: string;
  quoteId: string;
  electionId: string;
  httpApi?: string;
}): Promise<IssuanceStartResponse> {
  const url = input.httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
  return fetchJson<IssuanceStartResponse>(`${url}/issuance/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      npub: input.npub,
      quote_id: input.quoteId,
      election_id: input.electionId,
    }),
  });
}

export async function awaitIssuanceStatus(input: {
  requestId: string;
  timeoutMs?: number;
  httpApi?: string;
}): Promise<IssuanceAwaitResponse> {
  const url = input.httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
  const timeoutMs = input.timeoutMs ?? 30000;
  return fetchJson<IssuanceAwaitResponse>(`${url}/issuance/${input.requestId}?timeout_ms=${timeoutMs}`, {
    method: "GET",
  });
}

export type FinalResultInfo = {
  election_id: string;
  total_votes: number;
  results: Record<string, Record<string, number>>;
  merkle_root: string;
  total_proofs_burned: number;
  issuance_commitment_root: string;
  spent_commitment_root: string;
  max_supply: number;
  event_id: string;
  closed_at: number;
};

export async function fetchResult(httpApi?: string): Promise<FinalResultInfo | null> {
  if (USE_MOCK) {
    try {
      return await fetchJson<FinalResultInfo>("/api/result");
    } catch {
      return null;
    }
  }

  try {
    const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
    return await fetchJson<FinalResultInfo>(`${url}/result`);
  } catch {
    return null;
  }
}

export type VoteTreeLeaf = {
  index: number;
  hash: string;
  event_id: string;
};

export type VoteTreeResponse = {
  merkle_root: string;
  total_leaves: number;
  leaves: VoteTreeLeaf[];
  levels: string[][];
};

export async function fetchVoteTree(httpApi?: string): Promise<VoteTreeResponse | null> {
  if (USE_MOCK) {
    return null;
  }

  try {
    const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
    return await fetchJson<VoteTreeResponse>(`${url}/vote_tree`);
  } catch {
    return null;
  }
}

export type InclusionProofResponse = {
  nostr_event_id: string;
  leaf_hash: string;
  merkle_path: Array<{ position: "left" | "right"; hash: string }>;
  merkle_root: string;
};

export async function fetchInclusionProof(eventId: string, httpApi?: string): Promise<InclusionProofResponse | null> {
  if (USE_MOCK) {
    return null;
  }

  try {
    const url = httpApi || `${import.meta.env.VITE_COORDINATOR_URL}`;
    return await fetchJson<InclusionProofResponse>(`${url}/inclusion_proof?event_id=${encodeURIComponent(eventId)}`);
  } catch {
    return null;
  }
}

export type CoordinatorDiscovery = {
  npub: string;
  httpApi: string;
  mintUrl: string;
  relays: string[];
};

export async function discoverCoordinators(
  electionEventId: string,
  relays: string[],
): Promise<CoordinatorDiscovery[]> {
  const publicRelays = relays.filter((r) => r.startsWith("wss://"));
  if (publicRelays.length === 0) return [];

  const pool = new SimplePool();
  try {
    const events = await Promise.race([
      pool.querySync(publicRelays, {
        kinds: [38008],
        ids: [electionEventId],
        limit: 1,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Nostr query timeout")), 8000)),
    ]);

    if (events.length === 0) return [];

    const electionEvent = events[0];
    const coordinatorNpubs = electionEvent.tags
      .filter((t) => t[0] === "coordinator" && t[1])
      .map((t) => t[1]);

    if (coordinatorNpubs.length === 0) {
      const creatorNpub = electionEvent.pubkey;
      if (creatorNpub) {
        coordinatorNpubs.push(creatorNpub);
      }
    }

    const discoveries: CoordinatorDiscovery[] = [];

    for (const npub of coordinatorNpubs) {
      try {
        const infoEvents = await Promise.race([
          pool.querySync(publicRelays, {
            kinds: [38012],
            authors: [npub],
            "#t": ["coordinator-info"],
            limit: 1,
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Nostr query timeout")), 5000)),
        ]);

        if (infoEvents.length > 0) {
          const content = JSON.parse(infoEvents[0].content);
          discoveries.push({
            npub,
            httpApi: content.http_api || "",
            mintUrl: content.mint_url || "",
            relays: content.supported_relays || relays,
          });
        }
      } catch {
        discoveries.push({ npub, httpApi: "", mintUrl: "", relays });
      }
    }

    return discoveries;
  } catch {
    return [];
  } finally {
    pool.close(publicRelays);
  }
}

export async function fetchPerCoordinatorTallies(
  coordinators: CoordinatorDiscovery[],
): Promise<PerCoordinatorTally[]> {
  const results: PerCoordinatorTally[] = [];

  for (const coord of coordinators) {
    if (!coord.httpApi) {
      results.push({ coordinatorNpub: coord.npub, httpApi: coord.httpApi, tally: null, result: null });
      continue;
    }

    try {
      const tallyUrl = new URL("/api/tally", coord.httpApi).toString();
      const resultUrl = new URL("/api/result", coord.httpApi).toString();
      const tally = await fetchJson<TallyInfo>(tallyUrl);
      let result: FinalResultInfo | null = null;
      try {
        result = await fetchJson<FinalResultInfo>(resultUrl);
      } catch {
        // no result yet
      }
      results.push({ coordinatorNpub: coord.npub, httpApi: coord.httpApi, tally, result });
    } catch {
      results.push({ coordinatorNpub: coord.npub, httpApi: coord.httpApi, tally: null, result: null });
    }
  }

  return results;
}

export async function runAudit(
  electionEventId: string,
  coordinators: CoordinatorDiscovery[],
  canonicalEligibleNpubs: string[],
  voteEnd: number,
  confirmEnd: number,
  relays: string[],
): Promise<AuditResult[]> {
  const publicRelays = relays.filter((r) => r.startsWith("wss://"));
  const canonicalSet = new Set(canonicalEligibleNpubs);
  const canonicalCount = canonicalEligibleNpubs.length;

  let confirmations = 0;
  let fakeConfirmations = 0;

  if (publicRelays.length > 0) {
    const pool = new SimplePool();
    try {
      const events = await Promise.race([
        pool.querySync(publicRelays, {
          kinds: [38013],
          "#e": [electionEventId],
          limit: canonicalCount * 2,
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Nostr query timeout")), 10000)),
      ]);

      for (const evt of events) {
        if (evt.created_at < voteEnd || evt.created_at > confirmEnd) continue;
        if (canonicalSet.has(evt.pubkey)) {
          confirmations++;
        } else {
          fakeConfirmations++;
        }
      }
    } catch {
      // confirmation count unavailable
    } finally {
      pool.close(publicRelays);
    }
  }

  const tallies = await fetchPerCoordinatorTallies(coordinators);

  return tallies.map((t) => {
    const flags: string[] = [];
    const tally = t.tally?.total_accepted_votes ?? t.result?.total_votes ?? 0;

    if (tally > canonicalCount) {
      flags.push("tally exceeds canonical eligible count");
    }
    if (tally > confirmations) {
      flags.push("possible inflation — tally exceeds canonical confirmations");
    }
    if (tally < confirmations) {
      flags.push("possible censorship — confirmations exceed tally");
    }

    return {
      coordinatorNpub: t.coordinatorNpub,
      tally,
      confirmations,
      fakeConfirmations,
      canonicalCount,
      flags,
    };
  });
}
