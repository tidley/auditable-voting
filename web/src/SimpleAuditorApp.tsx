import { useEffect, useMemo, useState } from "react";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import TokenFingerprint from "./TokenFingerprint";
import {
  fetchSimpleLiveVotes,
  subscribeSimpleSubmittedVotes,
  type SimpleLiveVoteSession,
  type SimpleSubmittedVote,
} from "./simpleVotingSession";
import { validateSimpleSubmittedVotes } from "./simpleVoteValidation";

function shortVotingId(votingId: string) {
  return votingId.slice(0, 12);
}

function byCreatedAtDescending<T extends { createdAt: string }>(values: T[]) {
  return [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export default function SimpleAuditorApp() {
  const [discoveredRounds, setDiscoveredRounds] = useState<SimpleLiveVoteSession[]>([]);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [submittedVotes, setSubmittedVotes] = useState<SimpleSubmittedVote[]>([]);
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refreshRounds() {
      try {
        const rounds = await fetchSimpleLiveVotes();
        if (cancelled) {
          return;
        }

        setDiscoveredRounds((current) => {
          const merged = new Map<string, SimpleLiveVoteSession>();
          for (const round of current) {
            merged.set(round.votingId, round);
          }
          for (const round of rounds) {
            const existing = merged.get(round.votingId);
            if (!existing || round.createdAt > existing.createdAt) {
              merged.set(round.votingId, round);
            }
          }
          return byCreatedAtDescending([...merged.values()]);
        });
        setRefreshStatus(rounds.length > 0 ? "Rounds refreshed from Nostr." : "No public rounds discovered yet.");
      } catch {
        if (!cancelled) {
          setRefreshStatus("Failed to refresh public rounds.");
        }
      }
    }

    void refreshRounds();
    const intervalId = window.setInterval(() => {
      void refreshRounds();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!selectedVotingId && discoveredRounds.length > 0) {
      setSelectedVotingId(discoveredRounds[0].votingId);
    }
  }, [discoveredRounds, selectedVotingId]);

  const selectedRound = useMemo(
    () => discoveredRounds.find((round) => round.votingId === selectedVotingId) ?? discoveredRounds[0] ?? null,
    [discoveredRounds, selectedVotingId],
  );

  useEffect(() => {
    const votingId = selectedRound?.votingId;
    if (!votingId) {
      setSubmittedVotes([]);
      return;
    }

    return subscribeSimpleSubmittedVotes({
      votingId,
      onVotes: (nextVotes) => {
        setSubmittedVotes(nextVotes);
      },
    });
  }, [selectedRound?.votingId]);

  const validatedVotes = useMemo(
    () => validateSimpleSubmittedVotes(
      submittedVotes,
      Math.max(1, selectedRound?.thresholdT ?? 1),
      selectedRound?.authorizedCoordinatorNpubs ?? [],
    ),
    [selectedRound?.authorizedCoordinatorNpubs, selectedRound?.thresholdT, submittedVotes],
  );

  const validYesCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "Yes").length;
  const validNoCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "No").length;
  const invalidCount = validatedVotes.filter((entry) => !entry.valid).length;

  async function refreshNow() {
    setRefreshStatus("Refreshing public rounds...");
    try {
      const rounds = await fetchSimpleLiveVotes();
      setDiscoveredRounds(byCreatedAtDescending(rounds));
      setRefreshStatus(rounds.length > 0 ? "Rounds refreshed from Nostr." : "No public rounds discovered yet.");
    } catch {
      setRefreshStatus("Failed to refresh public rounds.");
    }
  }

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <div className='simple-voter-header-row'>
          <h1 className='simple-voter-title'>Auditor</h1>
          <button type='button' className='simple-voter-primary' onClick={() => void refreshNow()}>
            Refresh rounds
          </button>
        </div>

        <SimpleCollapsibleSection title='Discovered rounds'>
          {discoveredRounds.length > 0 ? (
            <>
              <label className='simple-voter-label' htmlFor='simple-auditor-round'>
                Round
              </label>
              <select
                id='simple-auditor-round'
                className='simple-voter-input'
                value={selectedRound?.votingId ?? ''}
                onChange={(event) => setSelectedVotingId(event.target.value)}
              >
                {discoveredRounds.map((round) => (
                  <option key={round.eventId} value={round.votingId}>
                    {shortVotingId(round.votingId)} - {round.prompt}
                  </option>
                ))}
              </select>
              {selectedRound ? (
                <div className='simple-auditor-summary-grid'>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Question</p>
                    <p className='simple-voter-question'>{selectedRound.prompt}</p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Voting ID</p>
                    <p className='simple-voter-question'>{selectedRound.votingId}</p>
                  </div>
                  <div className='simple-auditor-summary-card'>
                    <p className='simple-auditor-summary-label'>Threshold</p>
                    <p className='simple-voter-question'>
                      {(selectedRound.thresholdT ?? 1)} of {(selectedRound.thresholdN ?? Math.max(1, selectedRound.authorizedCoordinatorNpubs.length || 1))}
                    </p>
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <p className='simple-voter-empty'>No public rounds discovered yet.</p>
          )}
          {refreshStatus ? <p className='simple-voter-note'>{refreshStatus}</p> : null}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Audit summary'>
          {selectedRound ? (
            <>
              <div className='simple-auditor-summary-grid'>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Valid Yes</p>
                  <p className='simple-auditor-score'>{validYesCount}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Valid No</p>
                  <p className='simple-auditor-score'>{validNoCount}</p>
                </div>
                <div className='simple-auditor-summary-card'>
                  <p className='simple-auditor-summary-label'>Invalid ballots</p>
                  <p className='simple-auditor-score'>{invalidCount}</p>
                </div>
              </div>
              <p className='simple-voter-question'>
                Authorized coordinators: {selectedRound.authorizedCoordinatorNpubs.length}
              </p>
              <ul className='simple-delivery-diagnostics simple-delivery-diagnostics-compact'>
                {selectedRound.authorizedCoordinatorNpubs.map((npub) => (
                  <li key={npub} className='simple-delivery-ok'>{npub}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className='simple-voter-empty'>Choose a public round to audit.</p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Submitted votes'>
          {selectedRound ? (
            validatedVotes.length > 0 ? (
              <>
                <p className='simple-voter-question'>{selectedRound.prompt}</p>
                <p className='simple-voter-note'>Vote {selectedRound.votingId}</p>
                <p className='simple-submitted-score'>
                  Yes: {validYesCount} | No: {validNoCount}
                </p>
                <ul className='simple-voter-list'>
                  {validatedVotes.map(({ vote, valid, reason }) => (
                    <li key={vote.eventId} className='simple-voter-list-item'>
                      <div className='simple-submitted-vote-row'>
                        <div className='simple-submitted-vote-copy'>
                          <p className='simple-voter-question'>
                            Vote {vote.choice}{" "}
                            <span className={valid ? 'simple-status-valid' : 'simple-status-invalid'}>
                              [{valid ? 'Valid' : `Invalid: ${reason}`}]
                            </span>
                          </p>
                          <p className='simple-voter-note'>Ballot {vote.eventId}</p>
                        </div>
                        {vote.tokenId ? (
                          <TokenFingerprint tokenId={vote.tokenId} compact large hideMetadata />
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className='simple-voter-empty'>No submitted votes found for this round yet.</p>
            )
          ) : (
            <p className='simple-voter-empty'>Choose a public round to inspect ballots.</p>
          )}
        </SimpleCollapsibleSection>
      </section>
    </main>
  );
}
