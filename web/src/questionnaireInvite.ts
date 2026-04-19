import type { ElectionInviteMessage } from "./questionnaireOptionA";

export function parseInviteFromUrl(search = typeof window !== "undefined" ? window.location.search : ""): {
  electionId: string | null;
  invite: ElectionInviteMessage | null;
} {
  const params = new URLSearchParams(search);
  const electionId = (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || null;
  const coordinatorNpub = (params.get("coordinator") ?? "").trim();
  const invitedNpub = (params.get("invited") ?? "").trim();
  const encodedInvite = (params.get("invite") ?? "").trim();
  if (!encodedInvite) {
    if (electionId && coordinatorNpub && invitedNpub) {
      const voteUrl = typeof window !== "undefined"
        ? new URL(`simple.html${search.startsWith("?") ? search : `?${search}`}`, window.location.href).toString()
        : "";
      return {
        electionId,
        invite: {
          type: "election_invite",
          schemaVersion: 1,
          electionId,
          title: "Questionnaire",
          description: "",
          voteUrl,
          invitedNpub,
          coordinatorNpub,
          definition: null,
          expiresAt: null,
        },
      };
    }
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
  const base = input.baseUrl ?? (typeof window !== "undefined" ? window.location.href : "https://example.invalid/simple.html");
  const url = new URL("./", base);
  url.searchParams.set("role", "voter");
  url.searchParams.set("q", input.invite.electionId);
  url.searchParams.set("coordinator", input.invite.coordinatorNpub);
  url.searchParams.set("invited", input.invite.invitedNpub);
  return url.toString();
}
