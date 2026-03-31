export type SimpleVotingPackage = {
  votingId?: string;
  coordinatorNpub?: string;
  coordinators?: string[];
  prompt?: string;
  thresholdT?: number;
  thresholdN?: number;
};

export function serializeSimpleVotingPackage(input: SimpleVotingPackage): string {
  const coordinators = Array.from(new Set([
    ...(input.coordinators ?? []),
    ...(input.coordinatorNpub ? [input.coordinatorNpub] : []),
  ]));
  const lines = [
    input.votingId ? `Voting ID: ${input.votingId}` : "",
    coordinators.length > 0 ? "Coordinator npubs:" : "",
    ...coordinators.map((npub) => `- ${npub}`),
    input.prompt ? `Question: ${input.prompt}` : "",
    input.thresholdT && input.thresholdN ? `Threshold: ${input.thresholdT} of ${input.thresholdN}` : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function extractNpubs(rawValue: string): string[] {
  return Array.from(new Set(rawValue.match(/\bnpub1[023456789acdefghjklmnpqrstuvwxyz]+\b/g) ?? []));
}

function extractVotingId(rawValue: string): string {
  const labeledMatch = rawValue.match(/voting[\s_-]*id\s*:\s*([^\n\r]+)/i);
  if (labeledMatch?.[1]) {
    return labeledMatch[1].trim();
  }

  const compactLine = rawValue
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("-") && !line.startsWith("npub1") && !line.toLowerCase().startsWith("coordinator") && !line.toLowerCase().startsWith("question") && !line.toLowerCase().startsWith("threshold"));

  if (compactLine && !compactLine.includes(" ")) {
    return compactLine;
  }

  return "";
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

    if (parsed.voting_id || parsed.coordinator_npub || (Array.isArray(parsed.coordinators) && parsed.coordinators.length > 0)) {
      return {
        votingId: parsed.voting_id?.trim() || undefined,
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
    if (votingId || coordinatorNpub) {
      return {
        votingId: votingId || undefined,
        coordinatorNpub: coordinatorNpub || undefined,
      };
    }
  } catch {
    // Not a URL.
  }

  const coordinators = extractNpubs(trimmed);
  const votingId = extractVotingId(trimmed);

  if (votingId || coordinators.length > 0) {
    return {
      votingId: votingId || undefined,
      coordinatorNpub: coordinators[0],
      coordinators: coordinators.length > 0 ? coordinators : undefined,
    };
  }

  return { votingId: trimmed };
}
