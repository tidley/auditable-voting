import { useEffect, useMemo, useRef, useState } from "react";
import { buildInviteUrl } from "./questionnaireInvite";
import { createSignerService, SignerServiceError } from "./services/signerService";
import {
  QuestionnaireOptionACoordinatorRuntime,
  OptionARuntimeError,
} from "./questionnaireOptionARuntime";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_PROTOCOL_VERSION_V2,
  QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
} from "./questionnaireProtocolConstants";
import { deriveActorDisplayId } from "./actorDisplay";
import { UiButton, UiTextArea, UiTextField } from "./ui/DesignLayer";

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
  const [title, setTitle] = useState(props.title ?? "Vote");
  const [description, setDescription] = useState(props.description ?? "");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const queueProcessingInFlightRef = useRef(false);

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
          protocolVersion: QUESTIONNAIRE_PROTOCOL_VERSION_V2,
          flowMode: QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
          responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
        },
      });
      setSignedInNpub(next.election.coordinatorNpub);
      setStatus(`Using organiser identity ${deriveActorDisplayId(next.election.coordinatorNpub)}.`);
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
        protocolVersion: QUESTIONNAIRE_PROTOCOL_VERSION_V2,
        flowMode: QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
        responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
      });
      setSignedInNpub(next.election.coordinatorNpub);
      setStatus(`Signed in as ${deriveActorDisplayId(next.election.coordinatorNpub)}.`);
    } catch (error) {
      if (error instanceof SignerServiceError || error instanceof OptionARuntimeError) {
        setStatus(error.message);
        return;
      }
      setStatus("Organiser login failed.");
    }
  }

  function createNewId() {
    setSignedInNpub("");
    setStatus("Use Login to authenticate an organiser signer.");
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
      setStatus(
        sent.dmDelivered
          ? `Invite DM sent to ${deriveActorDisplayId(npub)}.`
          : `Invite saved locally for ${deriveActorDisplayId(npub)}; DM delivery failed (${sent.dmFailureReason ?? "unknown error"}).`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Invite failed.");
    }
  }

  async function processRequests() {
    try {
      await runtime.processPendingBlindRequests();
      const delivered = await runtime.publishPendingBlindIssuancesToDm({ forceAll: true });
      setStatus(delivered > 0
        ? `Processed pending blind ballot requests and sent ${delivered} credential DM${delivered === 1 ? "" : "s"}.`
        : "Processed pending blind ballot requests; no credential DM was accepted by relays."
      );
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
      if (queueProcessingInFlightRef.current) {
        return;
      }
      queueProcessingInFlightRef.current = true;
      try {
        void runtime.processPendingBlindRequests()
          .then(() => runtime.processPendingSubmissions([]))
          .then(() => setRefreshNonce((value) => value + 1))
          .catch(() => undefined)
          .finally(() => {
            queueProcessingInFlightRef.current = false;
          });
      } catch {
        queueProcessingInFlightRef.current = false;
        // Keep background processing best-effort; explicit actions surface errors.
      }
    }, 30000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [runtime, signedInNpub]);

  return (
    <div className='simple-voter-card simple-questionnaire-panel'>
      <div className='simple-questionnaire-header'>
        <div>
          <h3 className='simple-voter-question'>Organiser</h3>
          <p className='simple-voter-note'>Blind credential flow</p>
        </div>
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
          <UiButton icon='login' className='simple-voter-secondary' onPress={() => void login()}>Login</UiButton>
          <UiButton icon='add' className='simple-voter-secondary' onPress={createNewId}>New identity</UiButton>
        </div>
      </div>

      {signedInNpub ? <p className='simple-voter-note'>Signed in as {signedInNpub}</p> : null}
      <p className='simple-voter-note'>Questionnaire ID: {electionId}</p>

      <UiTextField
        label='Name'
        inputClassName='simple-voter-input'
        inputProps={{
          id: 'optiona-title',
          value: title,
          onChange: (event) => setTitle(event.target.value),
        }}
      />
      <UiTextArea
        label='Description'
        textAreaClassName='simple-voter-input'
        textAreaProps={{
          id: 'optiona-description',
          value: description,
          rows: 2,
          onChange: (event) => setDescription(event.target.value),
        }}
      />

      <h4 className='simple-voter-section-title'>Voters</h4>
      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <UiTextField
          inputClassName='simple-voter-input simple-voter-input-inline'
          inputProps={{
            value: whitelistInput,
            placeholder: 'npub1...',
            onChange: (event) => setWhitelistInput(event.target.value),
          }}
        />
        <UiButton icon='add' className='simple-voter-secondary' isDisabled={!signedInNpub.trim()} onPress={addWhitelist}>Add</UiButton>
      </div>

      {whitelistRows.length === 0 ? <p className='simple-voter-note'>No voters yet.</p> : (
        <ul className='simple-vote-status-list'>
          {whitelistRows.map((entry) => (
            <li key={entry.invitedNpub}>
              <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
              {deriveActorDisplayId(entry.invitedNpub)} - {entry.claimState}
              <UiButton
                icon='send'
                className='simple-voter-secondary'
                style={{ marginLeft: 8 }}
                isDisabled={!flags.canSendInvites}
                onPress={() => sendInvite(entry.invitedNpub)}
              >
                Send invite
              </UiButton>
            </li>
          ))}
        </ul>
      )}

      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <UiButton icon='key' className='simple-voter-secondary' isDisabled={!flags.canIssueBlindResponses} onPress={processRequests}>
          Issue pending ballots
        </UiButton>
        <UiButton icon='check' className='simple-voter-secondary' isDisabled={!flags.canAcceptVotes} onPress={processSubmissions}>
          Accept pending votes
        </UiButton>
      </div>

      <p className='simple-voter-note'>Accepted responses: {runtime.getAcceptedUniqueCount()}</p>
      {status ? <p className='simple-voter-note'>{status}</p> : null}
      <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
    </div>
  );
}
