import { useEffect, useMemo, useState } from "react";
import { buildInviteUrl } from "./questionnaireInvite";
import { createSignerService, SignerServiceError } from "./services/signerService";
import {
  QuestionnaireOptionACoordinatorRuntime,
  OptionARuntimeError,
} from "./questionnaireOptionARuntime";
import { deriveActorDisplayId } from "./actorDisplay";
import { tryWriteClipboard } from "./clipboard";

function deriveElectionId() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("election_id") ?? params.get("questionnaire") ?? "").trim() || `e_${crypto.randomUUID().slice(0, 8)}`;
}

type Props = {
  title?: string;
  description?: string;
  coordinatorNpub?: string | null;
};

export default function QuestionnaireOptionACoordinatorPanel(props: Props) {
  const electionId = useMemo(() => deriveElectionId(), []);
  const [runtime] = useState(() => new QuestionnaireOptionACoordinatorRuntime(createSignerService(), electionId));
  const [status, setStatus] = useState<string | null>(null);
  const [signedInNpub, setSignedInNpub] = useState("");
  const [whitelistInput, setWhitelistInput] = useState("");
  const [title, setTitle] = useState(props.title ?? "Questionnaire");
  const [description, setDescription] = useState(props.description ?? "");
  const [refreshNonce, setRefreshNonce] = useState(0);

  const snapshot = runtime.getSnapshot();
  const flags = runtime.getFlags();

  useEffect(() => {
    const npub = props.coordinatorNpub?.trim() ?? "";
    if (!npub || signedInNpub.trim()) {
      return;
    }
    try {
      const next = runtime.bootstrapCoordinatorNpub({
        coordinatorNpub: npub,
        summary: {
          electionId,
          title,
          description,
          state: "open",
        },
      });
      setSignedInNpub(next.election.coordinatorNpub);
      setStatus(`Using coordinator identity ${deriveActorDisplayId(next.election.coordinatorNpub)}.`);
      setRefreshNonce((value) => value + 1);
    } catch {
      // Keep manual signer login fallback.
    }
  }, [description, electionId, props.coordinatorNpub, runtime, signedInNpub, title]);

  async function login() {
    try {
      const next = await runtime.loginWithSigner({
        electionId,
        title,
        description,
        state: "open",
      });
      setSignedInNpub(next.election.coordinatorNpub);
      setStatus(`Signed in as ${deriveActorDisplayId(next.election.coordinatorNpub)}.`);
    } catch (error) {
      if (error instanceof SignerServiceError || error instanceof OptionARuntimeError) {
        setStatus(error.message);
        return;
      }
      setStatus("Coordinator login failed.");
    }
  }

  function createNewId() {
    setSignedInNpub("");
    setStatus("Use Login to authenticate a coordinator signer.");
  }

  function addWhitelist() {
    const npub = whitelistInput.trim();
    if (!npub) {
      return;
    }
    try {
      runtime.addWhitelistNpub(npub);
      setWhitelistInput("");
      setStatus("Whitelisted voter.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Whitelist failed.");
    }
  }

  async function sendInvite(npub: string) {
    try {
      const sent = await runtime.sendInvite(npub, {
        title,
        description,
        voteUrl: buildInviteUrl({
          invite: {
            type: "election_invite",
            schemaVersion: 1,
            electionId,
            title,
            description,
            voteUrl: "",
            invitedNpub: npub,
            coordinatorNpub: signedInNpub,
            expiresAt: null,
          },
        }),
      });
      const copied = await tryWriteClipboard(buildInviteUrl({ invite: sent.invite }));
      setStatus(
        sent.dmDelivered
          ? `Invite DM sent to ${deriveActorDisplayId(npub)}. ${copied ? "Voter URL copied." : "Browser blocked clipboard copy."}`
          : `Invite saved locally for ${deriveActorDisplayId(npub)}; DM delivery failed (${sent.dmFailureReason ?? "unknown error"}). ${copied ? "URL copied." : "Browser blocked clipboard copy."}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invite failed.");
    }
  }

  async function processRequests() {
    try {
      await runtime.processPendingBlindRequests();
      setStatus("Processed pending blind ballot requests.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request processing failed.");
    }
  }

  async function processSubmissions() {
    try {
      await runtime.processPendingSubmissions([]);
      setStatus("Processed pending submissions.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Submission processing failed.");
    }
  }

  const whitelistRows = Object.values(snapshot?.whitelist ?? {});

  useEffect(() => {
    if (!signedInNpub.trim()) {
      return;
    }
    const intervalId = window.setInterval(() => {
      try {
        void runtime.processPendingBlindRequests()
          .then(() => runtime.processPendingSubmissions([]))
          .then(() => setRefreshNonce((value) => value + 1))
          .catch(() => undefined);
      } catch {
        // Keep background processing best-effort; explicit actions surface errors.
      }
    }, 1500);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [runtime, signedInNpub]);

  return (
    <div className='simple-voter-card simple-questionnaire-panel'>
      <div className='simple-questionnaire-header'>
        <div>
          <h3 className='simple-voter-question'>Coordinator</h3>
          <p className='simple-voter-note'>Option A flow</p>
        </div>
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
          <button type='button' className='simple-voter-secondary' onClick={() => void login()}>Login</button>
          <button type='button' className='simple-voter-secondary' onClick={createNewId}>New ID</button>
        </div>
      </div>

      {signedInNpub ? <p className='simple-voter-note'>Signed in as {signedInNpub}</p> : null}
      <p className='simple-voter-note'>Election ID: {electionId}</p>

      <label className='simple-voter-label' htmlFor='optiona-title'>Questionnaire title</label>
      <input id='optiona-title' className='simple-voter-input' value={title} onChange={(event) => setTitle(event.target.value)} />
      <label className='simple-voter-label' htmlFor='optiona-description'>Description</label>
      <textarea id='optiona-description' className='simple-voter-input' value={description} rows={2} onChange={(event) => setDescription(event.target.value)} />

      <h4 className='simple-voter-section-title'>Whitelist</h4>
      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <input
          className='simple-voter-input simple-voter-input-inline'
          value={whitelistInput}
          placeholder='npub1...'
          onChange={(event) => setWhitelistInput(event.target.value)}
        />
        <button type='button' className='simple-voter-secondary' disabled={!signedInNpub.trim()} onClick={addWhitelist}>Add</button>
      </div>

      {whitelistRows.length === 0 ? <p className='simple-voter-note'>No whitelisted voters yet.</p> : (
        <ul className='simple-vote-status-list'>
          {whitelistRows.map((entry) => (
            <li key={entry.invitedNpub}>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              {deriveActorDisplayId(entry.invitedNpub)} - {entry.claimState}
              <button
                type='button'
                className='simple-voter-secondary'
                style={{ marginLeft: 8 }}
                disabled={!flags.canSendInvites}
                onClick={() => sendInvite(entry.invitedNpub)}
              >
                Send invite
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <button type='button' className='simple-voter-secondary' disabled={!flags.canIssueBlindResponses} onClick={processRequests}>
          Issue pending ballots
        </button>
        <button type='button' className='simple-voter-secondary' disabled={!flags.canAcceptVotes} onClick={processSubmissions}>
          Accept pending votes
        </button>
      </div>

      <p className='simple-voter-note'>Accepted unique responders: {runtime.getAcceptedUniqueCount()}</p>
      {status ? <p className='simple-voter-note'>{status}</p> : null}
      <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
    </div>
  );
}
