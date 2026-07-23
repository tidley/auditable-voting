import type { ElectionInviteMessage } from "./questionnaireOptionA";
import { normaliseQuestionnaireInviteCode } from "./questionnaireInviteCode";
import { normaliseQuestionnaireBallotGroup } from "./questionnaireProtocol";

const DEFAULT_INVITE_BASE_URL = "https://example.invalid/";
const CONSUMED_INVITE_CODE_STATE_KEY = "auditableVotingQuestionnaireInviteCode";

type ConsumedInviteCodeContext = {
  code: string;
  electionId: string;
};

function currentHistoryState() {
  if (typeof window === "undefined" || !window.history.state || typeof window.history.state !== "object") {
    return {} as Record<string, unknown>;
  }
  return window.history.state as Record<string, unknown>;
}

function readConsumedInviteCode(electionId: string | null) {
  const value = currentHistoryState()[CONSUMED_INVITE_CODE_STATE_KEY] as Partial<ConsumedInviteCodeContext> | undefined;
  if (!electionId || !value || typeof value !== "object" || value.electionId !== electionId) {
    return "";
  }
  return normaliseQuestionnaireInviteCode(value.code);
}

function fragmentPartIsInviteCodeParameter(part: string) {
  const separatorIndex = part.indexOf("=");
  if (separatorIndex < 0) {
    return false;
  }
  const key = [...new URLSearchParams(`${part.slice(0, separatorIndex)}=`).keys()][0];
  return key === "invite_code" || key === "code";
}

function withoutInviteCodeFragment(hash: string) {
  const fragment = hash.replace(/^#/, "");
  if (!fragment) {
    return "";
  }
  const retained = fragment.split("&").filter((part) => !fragmentPartIsInviteCodeParameter(part));
  return retained.length > 0 ? `#${retained.join("&")}` : "";
}

function resolveUrlParts(source: string | URL | undefined, hash: string | undefined, useCurrentPage: boolean) {
  const explicitUrl = source instanceof URL ? source : null;
  return {
    search: useCurrentPage && typeof window !== "undefined"
      ? window.location.search
      : explicitUrl?.search ?? (typeof source === "string" ? source : ""),
    hash: useCurrentPage && typeof window !== "undefined" ? window.location.hash : explicitUrl?.hash ?? hash ?? "",
    sourceUrl: useCurrentPage && typeof window !== "undefined" ? new URL(window.location.href) : explicitUrl,
  };
}

function firstInviteCode(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const normalised = normaliseQuestionnaireInviteCode(value);
    if (normalised) {
      return normalised;
    }
  }
  return "";
}

function parseCredentialsPerVoter(params: URLSearchParams): 2 | undefined {
  const value = (
    params.get("credentials_per_voter")
    ?? params.get("credentialsPerVoter")
    ?? ""
  ).trim();
  return value === "2" ? 2 : undefined;
}

export function parseInviteFromUrl(source?: string | URL, hash?: string): {
  electionId: string | null;
  invite: ElectionInviteMessage | null;
  inviteCode: string | null;
  coordinatorNpub: string | null;
  credentialsPerVoter?: 2;
  ballotGroup?: string | null;
} {
  const useCurrentPage = arguments.length === 0;
  const urlParts = resolveUrlParts(source, hash, useCurrentPage);
  const params = new URLSearchParams(urlParts.search);
  const fragmentParams = new URLSearchParams(urlParts.hash.replace(/^#/, ""));
  const electionId = (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || null;
  const coordinatorNpub = (params.get("coordinator") ?? "").trim();
  const invitedNpub = (params.get("invited") ?? "").trim();
  const credentialsPerVoter = parseCredentialsPerVoter(params);
  const ballotGroup = normaliseQuestionnaireBallotGroup(params.get("ballot_group") ?? params.get("ballotGroup"));
  const relayHints = params.getAll("relay")
    .concat((params.get("relays") ?? "").split(","))
    .map((entry) => entry.trim())
    .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index);
  const encodedInvite = (params.get("invite") ?? "").trim();
  const inviteCode = firstInviteCode(
    fragmentParams.get("invite_code"),
    fragmentParams.get("code"),
    params.get("invite_code"),
    params.get("code"),
    useCurrentPage ? readConsumedInviteCode(electionId) : "",
  );
  if (!encodedInvite) {
    if (electionId && coordinatorNpub && invitedNpub) {
      const voteUrl = urlParts.sourceUrl
        ? useCurrentPage
          ? new URL(`simple.html${urlParts.search.startsWith("?") ? urlParts.search : `?${urlParts.search}`}${urlParts.hash}`, urlParts.sourceUrl).toString()
          : urlParts.sourceUrl.toString()
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
          definitionReference: {
            questionnaireId: electionId,
            coordinatorNpub,
            relays: relayHints.length > 0 ? relayHints : undefined,
          },
          ...(credentialsPerVoter === 2 ? { credentialsPerVoter } : {}),
          ...(ballotGroup ? { ballotGroup } : {}),
          expiresAt: null,
        },
        inviteCode: inviteCode || null,
        coordinatorNpub: coordinatorNpub || null,
        ...(credentialsPerVoter === 2 ? { credentialsPerVoter } : {}),
        ...(ballotGroup ? { ballotGroup } : {}),
      };
    }
    return {
      electionId,
      invite: null,
      inviteCode: inviteCode || null,
      coordinatorNpub: coordinatorNpub || null,
      ...(credentialsPerVoter === 2 ? { credentialsPerVoter } : {}),
      ...(ballotGroup ? { ballotGroup } : {}),
    };
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
      return { electionId, invite: null, inviteCode: inviteCode || null, coordinatorNpub: coordinatorNpub || null, ...(credentialsPerVoter === 2 ? { credentialsPerVoter } : {}), ...(ballotGroup ? { ballotGroup } : {}) };
    }
    const parsedBallotGroup = normaliseQuestionnaireBallotGroup(parsed.ballotGroup) ?? ballotGroup;
    return { electionId: parsed.electionId, invite: parsed, inviteCode: inviteCode || null, coordinatorNpub: parsed.coordinatorNpub || coordinatorNpub || null, ...(credentialsPerVoter === 2 ? { credentialsPerVoter } : {}), ...(parsedBallotGroup ? { ballotGroup: parsedBallotGroup } : {}) };
  } catch {
    return { electionId, invite: null, inviteCode: inviteCode || null, coordinatorNpub: coordinatorNpub || null, ...(credentialsPerVoter === 2 ? { credentialsPerVoter } : {}), ...(ballotGroup ? { ballotGroup } : {}) };
  }
}

export function buildInviteUrl(input: {
  baseUrl?: string;
  invite: ElectionInviteMessage;
}) {
  return buildQuestionnaireInviteUrl({
    baseUrl: input.baseUrl,
    electionId: input.invite.electionId,
    coordinatorNpub: input.invite.coordinatorNpub,
    invitedNpub: input.invite.invitedNpub,
    relays: input.invite.definitionReference?.relays,
    credentialsPerVoter: input.invite.credentialsPerVoter,
    ballotGroup: input.invite.ballotGroup,
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
  relays?: string[] | null;
  credentialsPerVoter?: 1 | 2 | null;
  ballotGroup?: string | null;
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
    const fragmentParams = new URLSearchParams();
    fragmentParams.set("invite_code", inviteCode);
    url.hash = fragmentParams.toString();
  }
  for (const relay of input.relays ?? []) {
    const trimmed = relay.trim();
    if (trimmed) {
      url.searchParams.append("relay", trimmed);
    }
  }
  if (input.autoRequestBallot) {
    url.searchParams.set("request_ballot", "1");
  }
  if (input.credentialsPerVoter === 2) {
    url.searchParams.set("credentials_per_voter", "2");
  }
  const ballotGroup = normaliseQuestionnaireBallotGroup(input.ballotGroup);
  if (ballotGroup) {
    url.searchParams.set("ballot_group", ballotGroup);
  }
  return url.toString();
}

export function shouldAutoRequestBallotFromUrl(search = typeof window !== "undefined" ? window.location.search : "") {
  const params = new URLSearchParams(search);
  const value = (params.get("request_ballot") ?? params.get("auto_request") ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function hasVoterInviteContextInUrl(source?: string | URL, hash?: string) {
  const useCurrentPage = arguments.length === 0;
  const urlParts = resolveUrlParts(source, hash, useCurrentPage);
  const params = new URLSearchParams(urlParts.search);
  const fragmentParams = new URLSearchParams(urlParts.hash.replace(/^#/, ""));
  const electionId = (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || null;
  return Boolean(
    (params.get("q") ?? "").trim()
    || (params.get("election_id") ?? "").trim()
    || (params.get("questionnaire") ?? "").trim()
    || (params.get("coordinator") ?? "").trim()
    || (params.get("invited") ?? "").trim()
    || (params.get("invite") ?? "").trim()
    || (params.get("invite_code") ?? "").trim()
    || (params.get("code") ?? "").trim()
    || (fragmentParams.get("invite_code") ?? "").trim()
    || (fragmentParams.get("code") ?? "").trim()
    || (useCurrentPage ? readConsumedInviteCode(electionId) : ""),
  );
}

export function isGeneralVoterInviteUrl(source?: string | URL, hash?: string) {
  const useCurrentPage = arguments.length === 0;
  const urlParts = resolveUrlParts(source, hash, useCurrentPage);
  const params = new URLSearchParams(urlParts.search);
  const fragmentParams = new URLSearchParams(urlParts.hash.replace(/^#/, ""));
  const electionId = (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || null;
  if (!electionId) {
    return false;
  }

  const hasPrivateInviteContext = Boolean(
    (params.get("invited") ?? "").trim()
    || (params.get("invite") ?? "").trim()
    || (params.get("invite_code") ?? "").trim()
    || (params.get("code") ?? "").trim()
    || (fragmentParams.get("invite_code") ?? "").trim()
    || (fragmentParams.get("code") ?? "").trim()
    || (useCurrentPage ? readConsumedInviteCode(electionId) : "")
    || (params.get("credentials_per_voter") ?? "").trim()
    || (params.get("credentialsPerVoter") ?? "").trim(),
  );

  return !hasPrivateInviteContext;
}

export function consumeQuestionnaireInviteCodeFromUrl() {
  if (typeof window === "undefined") {
    return null;
  }
  const parsed = parseInviteFromUrl(window.location.search, window.location.hash);
  const inviteCode = parsed.inviteCode;
  const url = new URL(window.location.href);
  const fragmentParts = url.hash.replace(/^#/, "").split("&");
  const hasSecretInUrl = url.searchParams.has("invite_code")
    || url.searchParams.has("code")
    || fragmentParts.some(fragmentPartIsInviteCodeParameter);
  if (!hasSecretInUrl) {
    return readConsumedInviteCode(parsed.electionId) || null;
  }
  url.searchParams.delete("invite_code");
  url.searchParams.delete("code");
  url.hash = withoutInviteCodeFragment(url.hash);
  const state = { ...currentHistoryState() };
  delete state[CONSUMED_INVITE_CODE_STATE_KEY];
  if (inviteCode && parsed.electionId) {
    state[CONSUMED_INVITE_CODE_STATE_KEY] = { code: inviteCode, electionId: parsed.electionId } satisfies ConsumedInviteCodeContext;
  }
  window.history.replaceState(state, "", `${url.pathname}${url.search}${url.hash}`);
  return inviteCode || null;
}

export function clearQuestionnaireInviteCodeUrlContext() {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.delete("invite_code");
  url.searchParams.delete("code");
  url.hash = withoutInviteCodeFragment(url.hash);
  const state = { ...currentHistoryState() };
  delete state[CONSUMED_INVITE_CODE_STATE_KEY];
  window.history.replaceState(state, "", `${url.pathname}${url.search}${url.hash}`);
}
