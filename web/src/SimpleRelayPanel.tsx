import { useEffect, useMemo, useState } from 'react';
import SimpleCollapsibleSection from './SimpleCollapsibleSection';
import { SIMPLE_DM_RELAYS } from './simpleShardDm';
import { SIMPLE_PUBLIC_RELAYS } from './simpleVotingSession';

type RelayStrength = 'checking' | 'strong' | 'fair' | 'weak' | 'offline';

type RelayProbe = {
  relay: string;
  strength: RelayStrength;
  latencyMs?: number;
  detail: string;
};

function classifyRelayStrength(latencyMs: number): RelayStrength {
  if (latencyMs < 400) {
    return 'strong';
  }
  if (latencyMs < 900) {
    return 'fair';
  }
  return 'weak';
}

async function probeRelay(relay: string): Promise<RelayProbe> {
  const startedAt = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(relay);
      const timeoutId = window.setTimeout(() => {
        socket.close();
        reject(new Error('Timed out'));
      }, 4000);

      socket.onopen = () => {
        window.clearTimeout(timeoutId);
        socket.close();
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timeoutId);
        socket.close();
        reject(new Error('Connection failed'));
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
  } catch {
    return {
      relay,
      strength: 'offline',
      detail: 'Offline',
    };
  }
}

function RelayProbeList({
  title,
  relays,
}: {
  title: string;
  relays: string[];
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

    void Promise.all(relays.map((relay) => probeRelay(relay))).then(
      (results) => {
        if (!cancelled) {
          setProbes(results);
        }
      },
    );

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
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function SimpleRelayPanel() {
  const publicRelays = useMemo(
    () => Array.from(new Set(SIMPLE_PUBLIC_RELAYS)),
    [],
  );
  const dmRelays = useMemo(() => Array.from(new Set(SIMPLE_DM_RELAYS)), []);

  return (
    <SimpleCollapsibleSection
      title='Relays'
      defaultCollapsed
      renderWhenExpanded
    >
      <p className='simple-voter-note'>
        Traffic is routed via selected relays and user-specific relay hints (
        <a href='https://nostr-nips.com/nip-65'>NIP-65</a>). Messages are
        delivered to the recipient's inbox relays, while public data is fetched
        from authors' outbox relays.
      </p>
      <RelayProbeList title='Public relays' relays={publicRelays} />
      <RelayProbeList title='DM relays' relays={dmRelays} />
    </SimpleCollapsibleSection>
  );
}
