import type { ElectionInviteMessage } from "./questionnaireOptionA";
import { normaliseQuestionnaireInviteCode } from "./questionnaireInviteCode";

const DEFAULT_INVITE_BASE_URL = "https://example.invalid/";

export function parseInviteFromUrl(search = typeof window !== "undefined" ? window.location.search : ""): {
  electionId: string | null;
  invite: ElectionInviteMessage | null;
  inviteCode: string | null;
  coordinatorNpub: string | null;
} {
  const params = new URLSearchParams(search);
  const electionId = (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || null;
  const coordinatorNpub = (params.get("coordinator") ?? "").trim();
  const invitedNpub = (params.get("invited") ?? "").trim();
  const encodedInvite = (params.get("invite") ?? "").trim();
  const inviteCode = normaliseQuestionnaireInviteCode(params.get("invite_code") ?? params.get("code"));
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
        inviteCode: inviteCode || null,
        coordinatorNpub: coordinatorNpub || null,
      };
    }
    return { electionId, invite: null, inviteCode: inviteCode || null, coordinatorNpub: coordinatorNpub || null };
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
      return { electionId, invite: null, inviteCode: inviteCode || null, coordinatorNpub: coordinatorNpub || null };
    }
    return { electionId: parsed.electionId, invite: parsed, inviteCode: inviteCode || null, coordinatorNpub: parsed.coordinatorNpub || coordinatorNpub || null };
  } catch {
    return { electionId, invite: null, inviteCode: inviteCode || null, coordinatorNpub: coordinatorNpub || null };
  }
}

export function buildInviteUrl(input: {
  baseUrl?: string;
  invite: ElectionInviteMessage;
}) {
  return buildQuestionnaireInviteUrl({
    baseUrl: input.baseUrl,
    electionId: input.invite.electionId,
  });
}

export function buildQuestionnaireInviteUrl(input: {
  baseUrl?: string;
  electionId: string;
  coordinatorNpub?: string | null;
  invitedNpub?: string | null;
  inviteCode?: string | null;
  login?: boolean;
  autoRequestBallot?: boolean;
}) {
  const base = input.baseUrl ?? (typeof window !== "undefined" ? window.location.href : DEFAULT_INVITE_BASE_URL);
  const url = new URL("./", base);
  if (input.login !== false) {
    url.searchParams.set("login", "1");
  }
  url.searchParams.set("role", "voter");
  url.searchParams.set("q", input.electionId.trim());
  const coordinatorNpub = input.coordinatorNpub?.trim() ?? "";
  const invitedNpub = input.invitedNpub?.trim() ?? "";
  if (coordinatorNpub) {
    url.searchParams.set("coordinator", coordinatorNpub);
  }
  if (coordinatorNpub && invitedNpub) {
    url.searchParams.set("invited", invitedNpub);
  }
  const inviteCode = normaliseQuestionnaireInviteCode(input.inviteCode);
  if (inviteCode) {
    url.searchParams.set("invite_code", inviteCode);
  }
  if (input.autoRequestBallot) {
    url.searchParams.set("request_ballot", "1");
  }
  return url.toString();
}

export function shouldAutoRequestBallotFromUrl(search = typeof window !== "undefined" ? window.location.search : "") {
  const params = new URLSearchParams(search);
  const value = (params.get("request_ballot") ?? params.get("auto_request") ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function hasVoterInviteContextInUrl(search = typeof window !== "undefined" ? window.location.search : "") {
  const params = new URLSearchParams(search);
  return Boolean(
    (params.get("q") ?? "").trim()
    || (params.get("election_id") ?? "").trim()
    || (params.get("questionnaire") ?? "").trim()
    || (params.get("coordinator") ?? "").trim()
    || (params.get("invited") ?? "").trim()
    || (params.get("invite") ?? "").trim()
    || (params.get("invite_code") ?? "").trim()
    || (params.get("code") ?? "").trim(),
  );
}
