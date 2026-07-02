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
import { UiButton, UiSwitch, UiTextField } from './ui/DesignLayer';

type RelayStrength = 'checking' | 'strong' | 'fair' | 'weak' | 'offline';

type RelayProbe = {
  relay: string;
  strength: RelayStrength;
  latencyMs?: number;
  detail: string;
};

const RELAY_PROBE_TIMEOUT_MS = 4000;
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
    return {
      relay,
      strength: 'offline',
      detail: 'Offline',
    };
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
  probesByRelay,
  renderRelayAction,
}: {
  title: string;
  relays: string[];
  probesByRelay: Map<string, RelayProbe>;
  renderRelayAction?: (relay: string) => ReactNode;
}) {
  const probes = useMemo(
    () => relays.map((relay) => probesByRelay.get(relay) ?? ({
      relay,
      strength: 'checking' as const,
      detail: 'Checking',
    })),
    [probesByRelay, relays],
  );

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
  const questionnaireRelayMetadata = questionnaireRelaysForMetadata(configuredQuestionnaireRelays) ?? [];
  const [useDefaultQuestionnaireRelays, setUseDefaultQuestionnaireRelays] = useState(configuredQuestionnaireRelays.length === 0);
  useEffect(() => {
    if (configuredQuestionnaireRelays.length > 0) {
      setUseDefaultQuestionnaireRelays(false);
    }
  }, [configuredQuestionnaireRelays.length]);
  const displayedQuestionnaireRelays = useDefaultQuestionnaireRelays
    ? DEFAULT_QUESTIONNAIRE_RELAYS
    : configuredQuestionnaireRelays;
  const allDisplayedRelays = useMemo(
    () => Array.from(new Set([
      ...displayedQuestionnaireRelays,
      ...publicRelays,
      ...dmRelays,
      ...mailboxRelays,
    ])),
    [displayedQuestionnaireRelays, dmRelays, mailboxRelays, publicRelays],
  );
  const [probesByRelay, setProbesByRelay] = useState<Map<string, RelayProbe>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    setProbesByRelay(new Map(allDisplayedRelays.map((relay) => [relay, {
      relay,
      strength: 'checking',
      detail: 'Checking',
    }])));

    void probeRelaysInBatches(allDisplayedRelays, (probe) => {
      if (cancelled) {
        return;
      }
      setProbesByRelay((current) => {
        const next = new Map(current);
        next.set(probe.relay, probe);
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [allDisplayedRelays]);
  const questionnaireRelayStatus = !useDefaultQuestionnaireRelays && questionnaireRelayMetadata.length > 0
    ? `${questionnaireRelayMetadata.length} custom relay${questionnaireRelayMetadata.length === 1 ? "" : "s"} will be published in new questionnaire metadata.`
    : !useDefaultQuestionnaireRelays
      ? "Add at least one relay, or turn Use default back on."
      : "";

  const setQuestionnaireRelays = (relays: string[]) => {
    onQuestionnaireRelaysInputChange?.(relays.join("\n"));
  };

  const addQuestionnaireRelay = () => {
    const nextRelay = normalizeQuestionnaireRelays(questionnaireRelayDraft)[0];
    if (!nextRelay) {
      return;
    }
    setUseDefaultQuestionnaireRelays(false);
    setQuestionnaireRelays([...displayedQuestionnaireRelays, nextRelay]);
    setQuestionnaireRelayDraft("");
  };

  const removeQuestionnaireRelay = (relay: string) => {
    const nextRelays = displayedQuestionnaireRelays.filter((entry) => entry !== relay);
    if (nextRelays.length === 0) {
      setUseDefaultQuestionnaireRelays(true);
    }
    setQuestionnaireRelays(nextRelays);
  };

  return (
    <SimpleCollapsibleSection
      title='Relays'
      titleToggleLabel='Relays'
      defaultCollapsed
      renderWhenExpanded
      expandSignal={expandSignal}
    >
      {editableQuestionnaireRelays ? (
        <div className='simple-relay-group'>
          <div className='simple-relay-settings-head'>
            <h3 className='simple-relay-heading'>Relays</h3>
            <UiSwitch
              className={`simple-relay-default-toggle${useDefaultQuestionnaireRelays ? " is-on" : ""}`}
              label='Use default'
              isSelected={useDefaultQuestionnaireRelays}
              onChange={(useDefaults) => {
                  setUseDefaultQuestionnaireRelays(useDefaults);
                  if (useDefaults) {
                    onQuestionnaireRelaysInputChange?.("");
                    setQuestionnaireRelayDraft("");
                  }
              }}
            />
          </div>
          {questionnaireRelayStatus ? <p className='simple-voter-note'>{questionnaireRelayStatus}</p> : null}
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <UiTextField
              inputClassName='simple-voter-input simple-voter-input-inline'
              isDisabled={useDefaultQuestionnaireRelays}
              inputProps={{
                value: questionnaireRelayDraft,
                placeholder: "wss://relay.example",
                onChange: (event) => setQuestionnaireRelayDraft(event.target.value),
              }}
            />
            <UiButton
              icon='add'
              className='simple-voter-secondary'
              onPress={addQuestionnaireRelay}
              isDisabled={useDefaultQuestionnaireRelays || normalizeQuestionnaireRelays(questionnaireRelayDraft).length === 0}
            >
              Add relay
            </UiButton>
          </div>
          <RelayProbeList
            title={useDefaultQuestionnaireRelays ? 'Default questionnaire relays' : 'Custom questionnaire relays'}
            relays={displayedQuestionnaireRelays}
            probesByRelay={probesByRelay}
            renderRelayAction={useDefaultQuestionnaireRelays
              ? undefined
              : (relay) => (
                <UiButton
                  icon='delete'
                  className='simple-voter-secondary simple-relay-remove-button'
                  onPress={() => removeQuestionnaireRelay(relay)}
                >
                  Remove
                </UiButton>
              )}
          />
        </div>
      ) : null}
      <RelayProbeList title='Public relays' relays={publicRelays} probesByRelay={probesByRelay} />
      <RelayProbeList title='DM relays' relays={dmRelays} probesByRelay={probesByRelay} />
      <RelayProbeList title='Mailbox relays' relays={mailboxRelays} probesByRelay={probesByRelay} />
    </SimpleCollapsibleSection>
  );
}
