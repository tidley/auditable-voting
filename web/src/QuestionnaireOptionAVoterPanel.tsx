import { useEffect, useMemo, useState } from "react";
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
import { listInvitesFromMailbox, publishInviteToMailbox } from "./questionnaireOptionAStorage";
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

export default function QuestionnaireOptionAVoterPanel() {
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

  const inviteContext = useMemo(() => parseInviteFromUrl(), []);
  const [electionId, setElectionId] = useState(inviteContext.electionId ?? deriveElectionId());

  useEffect(() => {
    if (!electionId) {
      setRuntime(null);
      return;
    }
    const signer = createSignerService();
    setRuntime(new QuestionnaireOptionAVoterRuntime(signer, electionId));
  }, [electionId]);

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

  const snapshot = runtime?.getSnapshot() ?? null;
  const flags = runtime?.getFlags() ?? {
    canLogin: true,
    canRequestBallot: false,
    canSubmitVote: false,
    alreadySubmitted: false,
    resumeAvailable: false,
  };

  const requiredQuestionIds = useMemo(
    () => questions.filter((question) => question.required).map((question) => question.questionId),
    [questions],
  );

  async function loadPendingInvitesFromRelays(signerNpub: string) {
    try {
      const signer = createSignerService();
      const dmInvites = await fetchOptionAInviteDms({ signer, limit: 40 });
      for (const invite of dmInvites) {
        publishInviteToMailbox(invite);
      }
      const byKey = new Map<string, ElectionInviteMessage>();
      for (const invite of [...dmInvites, ...listInvitesFromMailbox(signerNpub)]) {
        byKey.set(`${invite.electionId}:${invite.coordinatorNpub}`, invite);
      }
      return [...byKey.values()];
    } catch {
      return listInvitesFromMailbox(signerNpub);
    }
  }

  async function login() {
    try {
      const signer = createSignerService();
      const rawPubkey = await signer.getPublicKey();
      const signerNpub = rawPubkey.startsWith("npub1") ? rawPubkey : nip19.npubEncode(rawPubkey);
      setSignedInNpub(signerNpub);

      if (!runtime) {
        const invites = await loadPendingInvitesFromRelays(signerNpub);
        setPendingInvites(invites);
        if (invites.length === 0) {
          setStatus("Signed in. No pending questionnaire invites were found.");
        } else {
          setStatus(`Signed in as ${deriveActorDisplayId(signerNpub)}. ${invites.length} pending invite${invites.length === 1 ? "" : "s"} found.`);
        }
        return;
      }

      const next = await runtime.loginWithSigner(inviteContext.invite);
      setSignedInNpub(next.invitedNpub);
      const invites = await loadPendingInvitesFromRelays(next.invitedNpub);
      setPendingInvites(invites);
      const pendingInvite = next.inviteMessage && !next.blindRequestSent && !next.credentialReady
        ? next.inviteMessage
        : null;
      setActiveInvite(pendingInvite);
      setStatus(`Signed in as ${deriveActorDisplayId(next.invitedNpub)}.`);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (error instanceof OptionARuntimeError || error instanceof SignerServiceError) {
        setStatus(error.message);
        return;
      }
      setStatus("Login failed.");
    }
  }

  async function openInvite(invite: ElectionInviteMessage, requestAfterLogin = false) {
    try {
      const voterRuntime = new QuestionnaireOptionAVoterRuntime(createSignerService(), invite.electionId);
      const next = await voterRuntime.loginWithSigner(invite);
      setElectionId(invite.electionId);
      setRuntime(voterRuntime);
      setSignedInNpub(next.invitedNpub);
      const refreshedInvites = await loadPendingInvitesFromRelays(next.invitedNpub);
      setPendingInvites(refreshedInvites);
      setActiveInvite(!next.blindRequestSent && !next.credentialReady ? invite : null);
      if (requestAfterLogin && !next.blindRequestSent && !next.credentialReady) {
        voterRuntime.requestBlindBallot();
        setStatus(`Opened ${invite.title || invite.electionId}. Blind ballot request sent.`);
      } else {
        setStatus(`Opened ${invite.title || invite.electionId}.`);
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
      {pendingInvites.length > 0 ? (
        <section className='simple-settings-card' aria-label='Pending questionnaire invites'>
          <h4 className='simple-voter-section-title'>Pending invites</h4>
          <ul className='simple-vote-status-list'>
            {pendingInvites.map((invite) => (
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
