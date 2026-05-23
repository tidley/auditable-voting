import { useEffect, useMemo, useState, type ReactNode } from 'react';
import SimpleCollapsibleSection from './SimpleCollapsibleSection';
import {
  DEFAULT_QUESTIONNAIRE_RELAYS,
  normalizeQuestionnaireRelays,
  questionnaireRelaysForMetadata,
} from './questionnaireRelays';
import { SIMPLE_MAILBOX_RELAYS } from './simpleMailbox';
import { SIMPLE_DM_RELAYS } from './simpleShardDm';
import { SIMPLE_PUBLIC_RELAYS } from './simpleVotingSession';

type RelayStrength = 'checking' | 'strong' | 'fair' | 'weak' | 'offline';

type RelayProbe = {
  relay: string;
  strength: RelayStrength;
  latencyMs?: number;
  detail: string;
};

const RELAY_PROBE_TIMEOUT_MS = 4000;
const RELAY_PROBE_RETRY_DELAY_MS = 350;
const RELAY_PROBE_CONCURRENCY = 3;

function classifyRelayStrength(latencyMs: number): RelayStrength {
  if (latencyMs < 400) {
    return 'strong';
  }
  if (latencyMs < 900) {
    return 'fair';
  }
  return 'weak';
}

async function attemptRelayProbe(relay: string): Promise<RelayProbe> {
  const startedAt = performance.now();
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(relay);
    let settled = false;
    let opened = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      socket.onopen = null;
      socket.onerror = null;
      socket.onclose = null;
      fn();
    };

    const timeoutId = window.setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore close failures from abandoned sockets.
      }
      finish(() => reject(new Error('Timed out')));
    }, RELAY_PROBE_TIMEOUT_MS);

    socket.onopen = () => {
      opened = true;
      try {
        socket.close(1000, 'relay probe complete');
      } catch {
        // Ignore close failures after a successful open.
      }
      finish(resolve);
    };

    socket.onerror = () => {
      finish(() => reject(new Error('Connection failed')));
    };

    socket.onclose = (event) => {
      if (opened || event.code === 1000) {
        finish(resolve);
        return;
      }
      finish(() => reject(new Error(event.reason || `Closed (${event.code})`)));
    };
  });

  const latencyMs = Math.round(performance.now() - startedAt);
  const strength = classifyRelayStrength(latencyMs);
  return {
    relay,
    strength,
    latencyMs,
    detail:
      strength === 'strong' ? 'Good' : strength === 'fair' ? 'Okay' : 'Slow',
  };
}

async function probeRelay(relay: string): Promise<RelayProbe> {
  try {
    return await attemptRelayProbe(relay);
  } catch {
    await new Promise((resolve) => window.setTimeout(resolve, RELAY_PROBE_RETRY_DELAY_MS));
    try {
      return await attemptRelayProbe(relay);
    } catch {
      return {
        relay,
        strength: 'offline',
        detail: 'Offline',
      };
    }
  }
}

async function probeRelaysInBatches(
  relays: string[],
  onProbe: (probe: RelayProbe) => void,
) {
  for (let index = 0; index < relays.length; index += RELAY_PROBE_CONCURRENCY) {
    const batch = relays.slice(index, index + RELAY_PROBE_CONCURRENCY);
    const results = await Promise.all(batch.map((relay) => probeRelay(relay)));
    for (const result of results) {
      onProbe(result);
    }
  }
}

function RelayProbeList({
  title,
  relays,
  renderRelayAction,
}: {
  title: string;
  relays: string[];
  renderRelayAction?: (relay: string) => ReactNode;
}) {
  const [probes, setProbes] = useState<RelayProbe[]>(() =>
    relays.map((relay) => ({
      relay,
      strength: 'checking',
      detail: 'Checking',
    })),
  );

  useEffect(() => {
    let cancelled = false;
    setProbes(
      relays.map((relay) => ({
        relay,
        strength: 'checking',
        detail: 'Checking',
      })),
    );

    void probeRelaysInBatches(relays, (probe) => {
      if (cancelled) {
        return;
      }
      setProbes((current) => current.map((entry) => (
        entry.relay === probe.relay ? probe : entry
      )));
    });

    return () => {
      cancelled = true;
    };
  }, [relays]);

  return (
    <div className='simple-relay-group'>
      <h3 className='simple-relay-heading'>{title}</h3>
      <ul className='simple-relay-list'>
        {probes.map((probe) => (
          <li key={probe.relay} className='simple-relay-item'>
            <code className='simple-relay-url'>{probe.relay}</code>
            <span className={`simple-relay-status is-${probe.strength}`}>
              {probe.detail}
              {probe.latencyMs ? ` · ${probe.latencyMs} ms` : ''}
            </span>
            {renderRelayAction ? renderRelayAction(probe.relay) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SimpleRelayPanel({
  expandSignal,
  questionnaireRelaysInput,
  onQuestionnaireRelaysInputChange,
}: {
  expandSignal?: number;
  questionnaireRelaysInput?: string;
  onQuestionnaireRelaysInputChange?: (value: string) => void;
}) {
  const [questionnaireRelayDraft, setQuestionnaireRelayDraft] = useState("");
  const publicRelays = useMemo(
    () => Array.from(new Set(SIMPLE_PUBLIC_RELAYS)),
    [],
  );
  const dmRelays = useMemo(() => Array.from(new Set(SIMPLE_DM_RELAYS)), []);
  const mailboxRelays = useMemo(() => Array.from(new Set(SIMPLE_MAILBOX_RELAYS)), []);
  const editableQuestionnaireRelays = typeof questionnaireRelaysInput === "string" && Boolean(onQuestionnaireRelaysInputChange);
  const configuredQuestionnaireRelays = useMemo(
    () => normalizeQuestionnaireRelays(questionnaireRelaysInput),
    [questionnaireRelaysInput],
  );
  const displayedQuestionnaireRelays = configuredQuestionnaireRelays.length > 0
    ? configuredQuestionnaireRelays
    : DEFAULT_QUESTIONNAIRE_RELAYS;
  const questionnaireRelayMetadata = questionnaireRelaysForMetadata(configuredQuestionnaireRelays) ?? [];
  const questionnaireRelayStatus = questionnaireRelayMetadata.length > 0
    ? `${questionnaireRelayMetadata.length} custom relay${questionnaireRelayMetadata.length === 1 ? "" : "s"} will be published in new questionnaire metadata.`
    : "New questionnaires will use the default relay metadata.";

  const setQuestionnaireRelays = (relays: string[]) => {
    onQuestionnaireRelaysInputChange?.(relays.join("\n"));
  };

  const addQuestionnaireRelay = () => {
    const nextRelay = normalizeQuestionnaireRelays(questionnaireRelayDraft)[0];
    if (!nextRelay) {
      return;
    }
    setQuestionnaireRelays([...displayedQuestionnaireRelays, nextRelay]);
    setQuestionnaireRelayDraft("");
  };

  const removeQuestionnaireRelay = (relay: string) => {
    setQuestionnaireRelays(displayedQuestionnaireRelays.filter((entry) => entry !== relay));
  };

  return (
    <SimpleCollapsibleSection
      title='Relays'
      defaultCollapsed
      renderWhenExpanded
      expandSignal={expandSignal}
    >
      <p className='simple-voter-note'>
        Traffic is routed via the selected relay sets below. Optional relay hints (
        <a href='https://nostr-nips.com/nip-65'>NIP-65</a>) are used only when
        enabled in Settings.
      </p>
      {editableQuestionnaireRelays ? (
        <div className='simple-relay-group'>
          <div className='simple-questionnaire-field-heading'>
            <h3 className='simple-relay-heading'>Questionnaire metadata relays</h3>
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => onQuestionnaireRelaysInputChange?.("")}
            >
              Use defaults
            </button>
          </div>
          <p className='simple-voter-note'>{questionnaireRelayStatus}</p>
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <input
              className='simple-voter-input simple-voter-input-inline'
              value={questionnaireRelayDraft}
              placeholder='wss://relay.example'
              onChange={(event) => setQuestionnaireRelayDraft(event.target.value)}
            />
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={addQuestionnaireRelay}
              disabled={normalizeQuestionnaireRelays(questionnaireRelayDraft).length === 0}
            >
              Add relay
            </button>
          </div>
          <RelayProbeList
            title='Current questionnaire relays'
            relays={displayedQuestionnaireRelays}
            renderRelayAction={(relay) => (
              <button
                type='button'
                className='simple-voter-secondary simple-relay-remove-button'
                onClick={() => removeQuestionnaireRelay(relay)}
              >
                Remove
              </button>
            )}
          />
        </div>
      ) : null}
      <RelayProbeList title='Public relays' relays={publicRelays} />
      <RelayProbeList title='DM relays' relays={dmRelays} />
      <RelayProbeList title='Mailbox relays' relays={mailboxRelays} />
    </SimpleCollapsibleSection>
  );
}
