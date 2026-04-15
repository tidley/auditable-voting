import type { ElectionInviteMessage } from "./questionnaireOptionA";

export function parseInviteFromUrl(search = typeof window !== "undefined" ? window.location.search : ""): {
  electionId: string | null;
  invite: ElectionInviteMessage | null;
} {
  const params = new URLSearchParams(search);
  const electionId = (params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || null;
  const encodedInvite = (params.get("invite") ?? "").trim();
  if (!encodedInvite) {
    return { electionId, invite: null };
  }

  try {
    const decoded = decodeURIComponent(encodedInvite);
    const parsed = JSON.parse(decoded) as ElectionInviteMessage;
    if (
      parsed?.type !== "election_invite"
      || parsed?.schemaVersion !== 1
      || typeof parsed?.electionId !== "string"
      || typeof parsed?.invitedNpub !== "string"
      || typeof parsed?.coordinatorNpub !== "string"
    ) {
      return { electionId, invite: null };
    }
    return { electionId: parsed.electionId, invite: parsed };
  } catch {
    return { electionId, invite: null };
  }
}

export function buildInviteUrl(input: {
  baseUrl?: string;
  invite: ElectionInviteMessage;
}) {
  const base = input.baseUrl ?? (typeof window !== "undefined" ? window.location.href : "https://example.invalid/vote.html");
  const url = new URL("vote.html", base);
  url.searchParams.set("qflow", "option_a");
  url.searchParams.set("election_id", input.invite.electionId);
  url.searchParams.set("invite", encodeURIComponent(JSON.stringify(input.invite)));
  return url.toString();
}
