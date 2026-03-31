export type SimpleVotingPackage = {
  votingId: string;
  coordinatorNpub?: string;
  coordinators?: string[];
  prompt?: string;
  thresholdT?: number;
  thresholdN?: number;
};

export function serializeSimpleVotingPackage(input: SimpleVotingPackage): string {
  return JSON.stringify({
    voting_id: input.votingId,
    coordinator_npub: input.coordinatorNpub,
    coordinators: input.coordinators,
    prompt: input.prompt,
    threshold_t: input.thresholdT,
    threshold_n: input.thresholdN,
  }, null, 2);
}

export function parseSimpleVotingPackage(rawValue: string): SimpleVotingPackage | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      voting_id?: string;
      coordinator_npub?: string;
      coordinators?: string[];
      prompt?: string;
      threshold_t?: number;
      threshold_n?: number;
    };

    if (parsed.voting_id) {
      return {
        votingId: parsed.voting_id,
        coordinatorNpub: parsed.coordinator_npub,
        coordinators: Array.isArray(parsed.coordinators) ? parsed.coordinators : undefined,
        prompt: parsed.prompt,
        thresholdT: typeof parsed.threshold_t === "number" ? parsed.threshold_t : undefined,
        thresholdN: typeof parsed.threshold_n === "number" ? parsed.threshold_n : undefined,
      };
    }
  } catch {
    // Fallbacks below.
  }

  try {
    const url = new URL(trimmed);
    const votingId = url.searchParams.get("voting")?.trim() ?? "";
    const coordinatorNpub = url.searchParams.get("coordinator")?.trim() ?? "";
    if (votingId) {
      return {
        votingId,
        coordinatorNpub: coordinatorNpub || undefined,
      };
    }
  } catch {
    // Not a URL.
  }

  return { votingId: trimmed };
}
