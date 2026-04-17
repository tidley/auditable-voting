import { useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import { fetchQuestionnaireDefinitions } from "./questionnaireTransport";
import { parseInviteFromUrl } from "./questionnaireInvite";
import { createSignerService, SignerServiceError } from "./services/signerService";
import {
  QuestionnaireOptionAVoterRuntime,
  OptionARuntimeError,
} from "./questionnaireOptionARuntime";
import type { ElectionInviteMessage, QuestionnaireAnswer } from "./questionnaireOptionA";
import { deriveActorDisplayId } from "./actorDisplay";
import {
  listInvitesFromMailbox,
  publishInviteToMailbox,
} from "./questionnaireOptionAStorage";
import { fetchOptionAInviteDms } from "./questionnaireOptionAInviteDm";

function deriveElectionId() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("election_id") ?? params.get("questionnaire") ?? "").trim();
}

function answerToOptionA(
  question: { questionId: string; type: "yes_no" | "multiple_choice" | "free_text" },
  value: unknown,
): QuestionnaireAnswer | null {
  if (question.type === "yes_no") {
    if (value !== "yes" && value !== "no") {
      return null;
    }
    return { questionId: question.questionId, type: "yes_no", answer: value };
  }
  if (question.type === "multiple_choice") {
    const answers = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    if (answers.length === 0) {
      return null;
    }
    return { questionId: question.questionId, type: "multiple_choice", answer: answers };
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  return { questionId: question.questionId, type: "text", answer: text };
}

type QuestionnaireOptionAVoterPanelProps = {
  announcedQuestionnaireIds?: string[];
  localVoterNpub?: string;
  localVoterNsec?: string;
};

export default function QuestionnaireOptionAVoterPanel(props: QuestionnaireOptionAVoterPanelProps) {
  const [runtime, setRuntime] = useState<QuestionnaireOptionAVoterRuntime | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [signedInNpub, setSignedInNpub] = useState<string>("");
  const [pendingInvites, setPendingInvites] = useState<ElectionInviteMessage[]>([]);
  const [activeInvite, setActiveInvite] = useState<ElectionInviteMessage | null>(null);
  const [questionnaireTitle, setQuestionnaireTitle] = useState<string>("Questionnaire");
  const [questionnaireDescription, setQuestionnaireDescription] = useState<string>("");
  const [questions, setQuestions] = useState<Array<{
    questionId: string;
    required: boolean;
    prompt: string;
    type: "yes_no" | "multiple_choice" | "free_text";
    options?: Array<{ optionId: string; label: string }>;
    multiSelect?: boolean;
    maxLength?: number;
  }>>([]);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [refreshNonce, setRefreshNonce] = useState(0);
  const autoRequestSentForRef = useRef<Record<string, true>>({});
  const requestRetryAtRef = useRef<Record<string, number>>({});

  const inviteContext = useMemo(() => parseInviteFromUrl(), []);
  const [electionId, setElectionId] = useState(inviteContext.electionId ?? deriveElectionId());
  const latestAnnouncedQuestionnaireId = useMemo(() => {
    const ids = (props.announcedQuestionnaireIds ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return ids.at(-1) ?? "";
  }, [props.announcedQuestionnaireIds]);

  const snapshot = runtime?.getSnapshot() ?? null;
  const flags = runtime?.getFlags() ?? {
    canLogin: true,
    canRequestBallot: false,
    canSubmitVote: false,
    alreadySubmitted: false,
    resumeAvailable: false,
  };

  useEffect(() => {
    if (!electionId) {
      setRuntime(null);
      return;
    }
    const signer = createSignerService();
    setRuntime(new QuestionnaireOptionAVoterRuntime(signer, electionId, props.localVoterNsec));
  }, [electionId]);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    if (!localVoterNpub) {
      return;
    }
    const signedIn = signedInNpub.trim();
    if (signedIn && signedIn !== localVoterNpub) {
      return;
    }
    const currentSnapshot = runtime.getSnapshot();
    if (currentSnapshot?.invitedNpub === localVoterNpub) {
      return;
    }
    try {
      ensureLocalSession({ allowInviteMissing: true });
    } catch {
      // Keep explicit login available.
    }
  }, [runtime, signedInNpub, props.localVoterNpub, electionId, latestAnnouncedQuestionnaireId]);

  useEffect(() => {
    if (!runtime || !signedInNpub.trim()) {
      return;
    }
    const intervalId = window.setInterval(() => {
      try {
        runtime.refreshIssuanceAndAcceptance();
        setRefreshNonce((value) => value + 1);
      } catch {
        // Keep polling best-effort; explicit actions surface errors.
      }
    }, 1500);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [runtime, signedInNpub]);

  useEffect(() => {
    setQuestionnaireTitle("Questionnaire");
    setQuestionnaireDescription("");
    setQuestions([]);
    setAnswers({});
    if (!electionId) {
      return;
    }
    let cancelled = false;
    void fetchQuestionnaireDefinitions({ questionnaireId: electionId, limit: 20 })
      .then((entries) => {
        if (cancelled) {
          return;
        }
        const latest = [...entries].sort((a, b) => (b.event.created_at ?? 0) - (a.event.created_at ?? 0))[0]?.definition;
        if (!latest) {
          return;
        }
        setQuestionnaireTitle(latest.title || "Questionnaire");
        setQuestionnaireDescription(latest.description || "");
        setQuestions(latest.questions.map((question) => ({
          questionId: question.questionId,
          required: question.required,
          prompt: question.prompt,
          type: question.type,
          options: question.type === "multiple_choice" ? question.options : undefined,
          multiSelect: question.type === "multiple_choice" ? question.multiSelect : undefined,
          maxLength: question.type === "free_text" ? question.maxLength : undefined,
        })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [electionId]);

  useEffect(() => {
    const currentId = electionId.trim();
    if (latestAnnouncedQuestionnaireId && (!currentId || (!hasInFlightState() && currentId !== latestAnnouncedQuestionnaireId))) {
      setElectionId(latestAnnouncedQuestionnaireId);
      return;
    }
    if (currentId) {
      return;
    }
    const localNpub = props.localVoterNpub?.trim() ?? "";
    if (!localNpub) {
      return;
    }
    const localInvite = findBestLocalInvite(localNpub, currentId);
    if (localInvite?.electionId?.trim()) {
      setElectionId(localInvite.electionId.trim());
    }
  }, [electionId, latestAnnouncedQuestionnaireId, props.localVoterNpub, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  useEffect(() => {
    if (pendingInvites.length === 0 || hasInFlightState()) {
      return;
    }
    const preferredInvite = (latestAnnouncedQuestionnaireId
      ? pendingInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId)
      : null)
      ?? pendingInvites.at(-1)
      ?? null;
    const nextElectionId = preferredInvite?.electionId?.trim() ?? "";
    if (nextElectionId && electionId.trim() !== nextElectionId) {
      setElectionId(nextElectionId);
    }
  }, [electionId, pendingInvites, latestAnnouncedQuestionnaireId, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  const requiredQuestionIds = useMemo(
    () => questions.filter((question) => question.required).map((question) => question.questionId),
    [questions],
  );

  function hasInFlightState(state = snapshot) {
    return Boolean(state?.blindRequest || state?.blindIssuance || state?.submission);
  }

  function findBestLocalInvite(voterNpub: string, preferredElectionId = electionId) {
    const localInvites = [...listInvitesFromMailbox(voterNpub)];
    const preferredId = preferredElectionId.trim();
    return (preferredId ? localInvites.find((invite) => invite.electionId === preferredId) : null)
      ?? (latestAnnouncedQuestionnaireId ? localInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId) : null)
      ?? localInvites.at(-1)
      ?? null;
  }

  function ensureLocalSession(options?: { allowInviteMissing?: boolean }) {
    if (!runtime) {
      return null;
    }
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    if (!localVoterNpub) {
      return runtime.getSnapshot();
    }
    const currentSnapshot = runtime.getSnapshot();
    if (currentSnapshot?.invitedNpub === localVoterNpub) {
      return currentSnapshot;
    }
    const fallbackInvite = findBestLocalInvite(localVoterNpub);
    const bootstrapNpub = fallbackInvite?.invitedNpub?.trim() || localVoterNpub;
    const next = runtime.bootstrapWithLocalIdentity({
      invitedNpub: bootstrapNpub,
      coordinatorNpub: fallbackInvite?.coordinatorNpub ?? undefined,
      invite: fallbackInvite,
      allowInviteRecipientMismatch: Boolean(fallbackInvite && bootstrapNpub !== (fallbackInvite.invitedNpub ?? "").trim()),
      allowInviteMissing: options?.allowInviteMissing ?? Boolean(latestAnnouncedQuestionnaireId || electionId.trim()),
    });
    setSignedInNpub(next.invitedNpub);
    void loadPendingInvites({ voterNpub: next.invitedNpub, allowRelayFetch: false }).then((invites) => {
      setPendingInvites(invites);
      const preferredInvite = invites.find((invite) => invite.electionId === next.electionId)
        ?? (latestAnnouncedQuestionnaireId ? invites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId) : null)
        ?? invites.at(-1)
        ?? null;
      setActiveInvite(next.inviteMessage && !next.blindRequestSent && !next.credentialReady
        ? next.inviteMessage
        : preferredInvite);
    });
    setRefreshNonce((value) => value + 1);
    return next;
  }

  async function loadPendingInvites(input: { voterNpub: string; allowRelayFetch: boolean }) {
    const voterNpub = input.voterNpub.trim();
    if (!voterNpub) {
      return [];
    }

    const fromMailbox = [...listInvitesFromMailbox(voterNpub)];

    const mergeByKey = (invites: ElectionInviteMessage[]) => {
      const byKey = new Map<string, ElectionInviteMessage>();
      for (const invite of invites) {
        byKey.set(invite.electionId + ":" + invite.coordinatorNpub, invite);
      }
      return [...byKey.values()];
    };

    if (!input.allowRelayFetch) {
      return mergeByKey(fromMailbox);
    }

    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    if (localVoterNpub && voterNpub === localVoterNpub) {
      return mergeByKey(fromMailbox);
    }

    try {
      const signer = createSignerService();
      const dmInvites = await fetchOptionAInviteDms({ signer, limit: 40 });
      for (const invite of dmInvites) {
        publishInviteToMailbox(invite);
      }
      return mergeByKey([...dmInvites, ...fromMailbox]);
    } catch {
      return mergeByKey(fromMailbox);
    }
  }

  async function loginWithLocalIdentity(voterNpub: string) {
    if (!runtime) {
      return false;
    }
    const fallbackInvite = findBestLocalInvite(voterNpub);
    const bootstrapNpub = fallbackInvite?.invitedNpub?.trim() || voterNpub;
    const next = runtime.bootstrapWithLocalIdentity({
      invitedNpub: bootstrapNpub,
      coordinatorNpub: fallbackInvite?.coordinatorNpub ?? undefined,
      invite: fallbackInvite,
      allowInviteRecipientMismatch: Boolean(fallbackInvite && bootstrapNpub !== (fallbackInvite.invitedNpub ?? "").trim()),
      allowInviteMissing: true,
    });
    setSignedInNpub(next.invitedNpub);
    const invites = await loadPendingInvites({ voterNpub: next.invitedNpub, allowRelayFetch: false });
    setPendingInvites(invites);
    const preferredInvite = invites.find((invite) => invite.electionId === electionId) ?? invites[0] ?? null;
    if (!inviteContext.electionId?.trim() && preferredInvite && electionId.trim() !== preferredInvite.electionId) {
      setElectionId(preferredInvite.electionId);
    }
    setActiveInvite(next.inviteMessage && !next.blindRequestSent && !next.credentialReady
      ? next.inviteMessage
      : preferredInvite);
    setStatus("Using local voter identity " + deriveActorDisplayId(next.invitedNpub) + ".");
    setRefreshNonce((value) => value + 1);
    return true;
  }

  async function login() {
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    const signedInTrimmed = signedInNpub.trim();

    if (localVoterNpub && (!signedInTrimmed || signedInTrimmed === localVoterNpub)) {
      try {
        const usedLocal = await loginWithLocalIdentity(localVoterNpub);
        if (usedLocal) {
          return;
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Local identity login failed.");
        return;
      }
    }

    try {
      const signer = createSignerService();
      const rawPubkey = await signer.getPublicKey();
      const signerNpub = rawPubkey.startsWith("npub1") ? rawPubkey : nip19.npubEncode(rawPubkey);

      if (!runtime) {
        const invites = await loadPendingInvites({ voterNpub: signerNpub, allowRelayFetch: true });
        setPendingInvites(invites);
        if (invites.length === 0) {
          setSignedInNpub(signerNpub);
          setStatus("Signed in. No pending questionnaire invites were found.");
          return;
        }

        const preferredInvite = invites[0] ?? null;
        if (!preferredInvite) {
          setSignedInNpub(signerNpub);
          setStatus("Signed in. No pending questionnaire invites were found.");
          return;
        }

        const voterRuntime = new QuestionnaireOptionAVoterRuntime(createSignerService(), preferredInvite.electionId, props.localVoterNsec);
        const next = await voterRuntime.loginWithSigner(preferredInvite);
        setElectionId(preferredInvite.electionId);
        setRuntime(voterRuntime);
        setSignedInNpub(next.invitedNpub);
        setActiveInvite(next.inviteMessage && !next.blindRequestSent && !next.credentialReady
          ? next.inviteMessage
          : preferredInvite);
        setStatus("Signed in as " + deriveActorDisplayId(next.invitedNpub) + ". " + invites.length + " pending invite" + (invites.length === 1 ? "" : "s") + " found.");
        setRefreshNonce((value) => value + 1);
        return;
      }

      const next = await runtime.loginWithSigner(inviteContext.invite);
      setSignedInNpub(next.invitedNpub);
      const invites = await loadPendingInvites({ voterNpub: next.invitedNpub, allowRelayFetch: true });
      setPendingInvites(invites);
      const preferredInvite = invites[0] ?? null;
      if (!inviteContext.electionId?.trim() && preferredInvite && electionId.trim() !== preferredInvite.electionId) {
        setElectionId(preferredInvite.electionId);
      }
      const pendingInvite = next.inviteMessage && !next.blindRequestSent && !next.credentialReady
        ? next.inviteMessage
        : preferredInvite;
      setActiveInvite(pendingInvite);
      setStatus("Signed in as " + deriveActorDisplayId(next.invitedNpub) + ".");
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (error instanceof OptionARuntimeError || error instanceof SignerServiceError) {
        setStatus(error.message);
        return;
      }
      setStatus(error instanceof Error ? error.message : "Login failed.");
    }
  }

  async function openInvite(invite: ElectionInviteMessage, requestAfterLogin = false) {
    try {
      const voterRuntime = new QuestionnaireOptionAVoterRuntime(createSignerService(), invite.electionId, props.localVoterNsec);
      const localVoterNpub = props.localVoterNpub?.trim() ?? "";
      const signedInTrimmed = signedInNpub.trim();
      const preferLocalIdentity = Boolean(localVoterNpub && (!signedInTrimmed || signedInTrimmed === localVoterNpub));

      let next;
      if (preferLocalIdentity) {
        next = voterRuntime.bootstrapWithLocalIdentity({
          invitedNpub: invite.invitedNpub?.trim() || localVoterNpub,
          coordinatorNpub: invite.coordinatorNpub,
          invite,
          allowInviteRecipientMismatch: true,
          allowInviteMissing: true,
        });
      } else {
        try {
          next = await voterRuntime.loginWithSigner(invite);
        } catch (error) {
          if (!(error instanceof SignerServiceError) && !(error instanceof OptionARuntimeError && error.code === "invite_mismatch")) {
            throw error;
          }
          next = voterRuntime.bootstrapWithLocalIdentity({
            invitedNpub: invite.invitedNpub?.trim() || props.localVoterNpub?.trim() || "",
            coordinatorNpub: invite.coordinatorNpub,
            invite,
            allowInviteRecipientMismatch: true,
            allowInviteMissing: true,
          });
        }
      }

      setElectionId(invite.electionId);
      setRuntime(voterRuntime);
      setSignedInNpub(next.invitedNpub);
      const refreshedInvites = await loadPendingInvites({
        voterNpub: next.invitedNpub,
        allowRelayFetch: false,
      });
      setPendingInvites(refreshedInvites.filter((entry) => entry.invitedNpub === next.invitedNpub));
      setActiveInvite(!next.blindRequestSent && !next.credentialReady ? invite : null);
      if (requestAfterLogin && !next.blindRequestSent && !next.credentialReady) {
        voterRuntime.requestBlindBallot();
        setStatus("Opened " + (invite.title || invite.electionId) + ". Blind ballot request sent.");
      } else {
        setStatus("Opened " + (invite.title || invite.electionId) + ".");
      }
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open invite.");
    }
  }

  function createNewId() {
    setSignedInNpub("");
    setStatus("Use Login to sign in with a signer account.");
  }

  function pushAnswers() {
    if (!runtime) {
      return;
    }
    const next = questions
      .map((question) => answerToOptionA(question, answers[question.questionId]))
      .filter((value): value is QuestionnaireAnswer => Boolean(value));
    runtime.updateDraftResponses(next);
    setRefreshNonce((value) => value + 1);
  }

  function requestBallot() {
    if (!runtime) {
      return;
    }
    try {
      ensureLocalSession({ allowInviteMissing: true });
      runtime.requestBlindBallot();
      setActiveInvite(null);
      setStatus("Blind ballot request sent. Waiting for coordinator issuance.");
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed.");
    }
  }

  function refreshStatus() {
    if (!runtime) {
      return;
    }
    try {
      ensureLocalSession({ allowInviteMissing: true });
      runtime.refreshIssuanceAndAcceptance();
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Refresh failed.");
    }
  }

  function submit() {
    if (!runtime) {
      return;
    }
    try {
      pushAnswers();
      runtime.submitVote(requiredQuestionIds);
      setStatus("Response submitted. Awaiting coordinator acceptance.");
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Submit failed.");
    }
  }

  useEffect(() => {
    if (!runtime || !snapshot || !snapshot.loginVerified) {
      return;
    }
    if (snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    const hasInviteContext = Boolean(
      snapshot.inviteMessage
      || activeInvite
      || latestAnnouncedQuestionnaireId === snapshot.electionId
      || pendingInvites.some((invite) => invite.electionId === snapshot.electionId),
    );
    if (!hasInviteContext) {
      return;
    }
    const key = snapshot.electionId + ":" + snapshot.invitedNpub;
    if (autoRequestSentForRef.current[key]) {
      return;
    }
    try {
      runtime.requestBlindBallot();
      autoRequestSentForRef.current[key] = true;
      setActiveInvite(null);
      setStatus("Blind ballot request sent. Waiting for coordinator issuance.");
      setRefreshNonce((value) => value + 1);
    } catch {
      // Keep manual request available if automatic send cannot proceed yet.
    }
  }, [activeInvite, latestAnnouncedQuestionnaireId, pendingInvites, runtime, snapshot]);

  useEffect(() => {
    if (!runtime || !snapshot?.loginVerified || !snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    const key = snapshot.electionId + ":" + snapshot.invitedNpub;
    const retry = () => {
      const now = Date.now();
      const lastAttemptAt = requestRetryAtRef.current[key] ?? 0;
      if (now - lastAttemptAt < 15000) {
        return;
      }
      requestRetryAtRef.current[key] = now;
      try {
        runtime.requestBlindBallot();
        runtime.refreshIssuanceAndAcceptance();
        setRefreshNonce((value) => value + 1);
      } catch {
        // Retry is best-effort; explicit controls surface errors.
      }
    };
    retry();
    const intervalId = window.setInterval(retry, 15000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [runtime, snapshot?.electionId, snapshot?.invitedNpub, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission]);

  const visiblePendingInvites = pendingInvites.filter((invite) => (
    !signedInNpub || invite.invitedNpub === signedInNpub || Boolean(props.localVoterNpub?.trim())
  ));
  const waitingForCredential = Boolean(snapshot?.blindRequestSent && !snapshot?.credentialReady && !snapshot?.submission);

  const canSubmitNow = flags.canSubmitVote && requiredQuestionIds.every((questionId) => {
    const value = answers[questionId];
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== undefined && value !== null && String(value).trim().length > 0;
  });

  return (
    <div className='simple-voter-card'>
      <div className='simple-questionnaire-header'>
        <div>
          <h3 className='simple-voter-question'>Questionnaire</h3>
          <p className='simple-voter-note'>Option A flow</p>
        </div>
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
          <button type='button' className='simple-voter-secondary' onClick={() => void login()}>Login</button>
          <button type='button' className='simple-voter-secondary' onClick={createNewId}>New ID</button>
        </div>
      </div>
      {signedInNpub ? <p className='simple-voter-note'>Signed in as {signedInNpub}</p> : null}
      <p className='simple-voter-note'>Election ID: {electionId || "Missing"}</p>
      {visiblePendingInvites.length > 0 ? (
        <section className='simple-settings-card' aria-label='Pending questionnaire invites'>
          <h4 className='simple-voter-section-title'>Pending invites</h4>
          <ul className='simple-vote-status-list'>
            {visiblePendingInvites.map((invite) => (
              <li key={`${invite.electionId}:${invite.coordinatorNpub}`}>
                <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
                {invite.title || invite.electionId}
                <button
                  type='button'
                  className='simple-voter-secondary'
                  style={{ marginLeft: 8 }}
                  onClick={() => void openInvite(invite)}
                >
                  Open
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  style={{ marginLeft: 8 }}
                  onClick={() => void openInvite(invite, true)}
                >
                  Open + request ballot
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {activeInvite && flags.canRequestBallot ? (
        <section className='simple-settings-card' aria-label='Invite action'>
          <p className='simple-voter-note'>
            Invite ready for {activeInvite.title || activeInvite.electionId}. Request your blind ballot to continue.
          </p>
          <button type='button' className='simple-voter-secondary' onClick={requestBallot}>
            Request blind ballot now
          </button>
        </section>
      ) : null}

      <ul className='simple-vote-status-list'>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Login verified: {snapshot?.loginVerified ? "Yes" : "No"}</li>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Ballot request sent: {snapshot?.blindRequestSent ? "Yes" : "No"}</li>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Credential ready: {snapshot?.credentialReady ? "Yes" : "No"}</li>
        <li><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Submission accepted: {snapshot?.submissionAccepted === true ? "Yes" : snapshot?.submissionAccepted === false ? "Rejected" : "Pending"}</li>
      </ul>

      {waitingForCredential ? (
        <p className='simple-voter-note'>Ballot request is queued for the coordinator. This questionnaire flow does not need a live round; keep this page open or ask the coordinator to use Process requests.</p>
      ) : null}

      <h4 className='simple-voter-section-title'>{questionnaireTitle}</h4>
      {questionnaireDescription ? <p className='simple-voter-note'>{questionnaireDescription}</p> : null}

      {questions.length === 0 ? <p className='simple-voter-note'>Waiting for questions to be published.</p> : (
        <div className='simple-questionnaire-voter-list'>
          {questions.map((question, index) => (
            <article key={question.questionId} className='simple-questionnaire-voter-card'>
              <p className='simple-questionnaire-voter-number'>Question {index + 1}</p>
              <h4 className='simple-questionnaire-voter-prompt'>{question.prompt || "Untitled question"}</h4>
              <p className='simple-questionnaire-voter-helper'>{question.required ? "Required" : "Optional"}</p>
              {question.type === "yes_no" ? (
                <div className='simple-vote-button-grid simple-questionnaire-yes-no-grid'>
                  <button type='button' className='simple-voter-choice simple-voter-choice-yes' onClick={() => setAnswers((current) => ({ ...current, [question.questionId]: "yes" }))}>Yes</button>
                  <button type='button' className='simple-voter-choice simple-voter-choice-no' onClick={() => setAnswers((current) => ({ ...current, [question.questionId]: "no" }))}>No</button>
                </div>
              ) : null}
              {question.type === "multiple_choice" ? (
                <div className='simple-questionnaire-choice-list'>
                  {(question.options ?? []).map((option) => {
                    const selected = Array.isArray(answers[question.questionId])
                      ? (answers[question.questionId] as string[])
                      : [];
                    const checked = selected.includes(option.optionId);
                    return (
                      <label key={option.optionId} className='simple-questionnaire-choice-row'>
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          checked={checked}
                          onChange={() => {
                            setAnswers((current) => {
                              const existing = Array.isArray(current[question.questionId])
                                ? (current[question.questionId] as string[])
                                : [];
                              if (!question.multiSelect) {
                                return { ...current, [question.questionId]: [option.optionId] };
                              }
                              return checked
                                ? { ...current, [question.questionId]: existing.filter((entry) => entry !== option.optionId) }
                                : { ...current, [question.questionId]: [...existing, option.optionId] };
                            });
                          }}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {question.type === "free_text" ? (
                <textarea
                  className='simple-voter-input simple-questionnaire-free-text'
                  rows={3}
                  maxLength={question.maxLength ?? 500}
                  value={typeof answers[question.questionId] === "string" ? (answers[question.questionId] as string) : ""}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.questionId]: event.target.value }))}
                />
              ) : null}
            </article>
          ))}
        </div>
      )}

      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <button type='button' className='simple-voter-secondary' disabled={!flags.canRequestBallot} onClick={requestBallot}>Request ballot</button>
        <button type='button' className='simple-voter-secondary' onClick={refreshStatus}>Refresh status</button>
        <button type='button' className='simple-voter-primary' disabled={!canSubmitNow} onClick={submit}>Submit response</button>
      </div>
      {flags.alreadySubmitted ? <p className='simple-voter-note'>You have already submitted one accepted vote for this election.</p> : null}
      {status ? <p className='simple-voter-note'>{status}</p> : null}
      <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
    </div>
  );
}
