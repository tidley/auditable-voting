import { useCallback, useEffect, useMemo, useState } from "react";
import { logClaimDebug } from "./cashuMintApi";
import { loadStoredWalletBundle, storeWalletBundle, addCoordinatorProof, type CoordinatorProof } from "./cashuWallet";
import { checkEligibility, type EligibilityCheckResponse } from "./voterManagementApi";
import {
  createCashuClaimEvent,
  deriveNpubFromNsec,
  formatDateTime,
  getNostrEventVerificationUrl,
  isValidNpub,
  publishCashuClaim,
  signCashuClaimEvent
} from "./nostrIdentity";
import { fetchCoordinatorInfo, fetchElectionsFromNostr, fetchElection, discoverCoordinators, startIssuanceTracking, awaitIssuanceStatus, type CoordinatorInfo, type ElectionInfo, type ElectionQuestion, type ElectionSummary, type CoordinatorDiscovery } from "./coordinatorApi";
import { checkQuoteStatus, createMintQuote, type MintQuoteResponse } from "./mintApi";
import { requestQuoteAndMint, type CashuProof } from "./cashuBlind";
import { DEMO_COPY, DEMO_MODE, MINT_URL, USE_MOCK } from "./config";
import {
  createRawSigner,
  createNip07Signer,
  startSignerDetection,
  type NostrSigner,
  type SignerMode
} from "./signer";

type PublishResult = {
  eventId: string;
  successes: number;
  failures: number;
};

type CoordinatorIssuanceState = "idle" | "requesting_quote" | "publishing_claim" | "polling" | "minting" | "done" | "error";

export default function App() {
  const [coordinatorInfo, setCoordinatorInfo] = useState<CoordinatorInfo | null>(null);
  const [electionInfo, setElectionInfo] = useState<ElectionInfo | null>(null);
  const [nsecInput, setNsecInput] = useState("");
  const [mintQuote, setMintQuote] = useState<MintQuoteResponse | null>(null);
  const [quoteState, setQuoteState] = useState<"UNPAID" | "PAID" | "ISSUED" | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [currentProof, setCurrentProof] = useState<CashuProof | null>(null);
  const [walletBundle, setWalletBundle] = useState(() => loadStoredWalletBundle());
  const [eligibilityResult, setEligibilityResult] = useState<EligibilityCheckResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [requestingQuote, setRequestingQuote] = useState(false);
  const [publishingClaim, setPublishingClaim] = useState(false);
  const [pollingQuote, setPollingQuote] = useState(false);
  const [mintingTokens, setMintingTokens] = useState(false);
  const [signerMode, setSignerMode] = useState<SignerMode>("raw");
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  const [nip07Pubkey, setNip07Pubkey] = useState<string | null>(null);
  const [nip07Scanning, setNip07Scanning] = useState(false);
  const [allElections, setAllElections] = useState<ElectionSummary[]>([]);
  const [electionsLoading, setElectionsLoading] = useState(false);
  const [discoveredCoordinators, setDiscoveredCoordinators] = useState<CoordinatorDiscovery[]>([]);
  const [issuanceProgress, setIssuanceProgress] = useState<Record<string, CoordinatorIssuanceState>>({});
  const [issuanceErrors, setIssuanceErrors] = useState<Record<string, string>>({});
  const [multiIssuanceRunning, setMultiIssuanceRunning] = useState(false);

  const derivedNpub = useMemo(() => deriveNpubFromNsec(nsecInput), [nsecInput]);
  const activeNpub = signerMode === "nip07" && nip07Pubkey ? nip07Pubkey : derivedNpub;
  const npubIsValid = activeNpub ? isValidNpub(activeNpub) : false;
  const canRequestQuote = Boolean(eligibilityResult?.canProceed && !requestingQuote && !multiIssuanceRunning);

  const coordinatorNpub = coordinatorInfo?.coordinatorNpub ?? "";
  const mintUrl = coordinatorInfo?.mintUrl ?? MINT_URL;
  const relays = coordinatorInfo?.relays ?? [];
  const electionId = electionInfo?.election_id ?? "";
  const questions: ElectionQuestion[] = electionInfo?.questions ?? [];

  const activeMintUrl = useMemo(() => mintUrl.replace(/\/$/, ""), [mintUrl]);

  async function handleElectionSelect(electionId: string) {
    if (electionId === electionInfo?.election_id) return;
    const summary = allElections.find((e) => e.election_id === electionId);
    if (!summary) return;
    const { SimplePool } = await import("nostr-tools");
    const pool = new SimplePool();
    const publicRelays = relays.filter((r) => r.startsWith("wss://"));
    try {
      if (publicRelays.length === 0) return;
      const events = await pool.querySync(publicRelays, { kinds: [38008], ids: [summary.event_id], limit: 1 });
      if (events.length === 0) return;
      const content = JSON.parse(events[0].content);
      setElectionInfo({
        election_id: electionId,
        event_id: summary.event_id,
        title: content.title ?? "Untitled",
        description: content.description ?? "",
        questions: content.questions ?? [],
        vote_start: (content as any).vote_start ?? (content as any).start_time ?? 0,
        vote_end: (content as any).vote_end ?? (content as any).end_time ?? 0,
        mint_urls: content.mint_urls ?? [],
        coordinator_npubs: (content as any).coordinator_npubs ?? [],
      });
      setMintQuote(null);
      setQuoteState(null);
      setPublishResult(null);
      setCurrentProof(null);
      setEligibilityResult(null);
      setStatus(`Switched to election: ${content.title ?? electionId}`);
    } catch {
      setError("Failed to load election from Nostr");
    } finally {
      pool.close(publicRelays);
    }
  }

  const claimVerificationUrl = useMemo(() => {
    if (!publishResult || publishResult.successes < 1) {
      return null;
    }

    return getNostrEventVerificationUrl({
      eventId: publishResult.eventId,
      relays
    });
  }, [publishResult, relays]);

  useEffect(() => {
    async function discover() {
      setDiscoveryLoading(true);
      setElectionsLoading(true);
      try {
        const [info, election] = await Promise.all([
          fetchCoordinatorInfo(),
          fetchElection()
        ]);
        setCoordinatorInfo(info);
        setElectionInfo(election);
        setStatus(`Connected to coordinator. Election: ${election?.title ?? "none"}`);

        const elections = await fetchElectionsFromNostr([info.coordinatorNpub], info.relays);
        setAllElections(elections);

        if (election?.event_id && election.coordinator_npubs.length > 1) {
          const discovered = await discoverCoordinators(election.event_id, info.relays);
          setDiscoveredCoordinators(discovered);
          if (discovered.length > 1) {
            setStatus(`Discovered ${discovered.length} coordinators. Election: ${election.title}`);
          }
        } else if (election?.event_id) {
          const discovered = await discoverCoordinators(election.event_id, info.relays);
          setDiscoveredCoordinators(discovered);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not reach coordinator");
      } finally {
        setDiscoveryLoading(false);
        setElectionsLoading(false);
      }
    }

    void discover();
  }, []);

  useEffect(() => {
    const stop = startSignerDetection((result) => {
      if (result.mode === "nip07" && result.signer) {
        setSignerMode("nip07");
        setSigner(result.signer);
        setNip07Scanning(false);
        result.signer.getNpub().then((npub) => setNip07Pubkey(npub)).catch(() => {});
      }
    });
    setNip07Scanning(signerMode === "nip07" && !nip07Pubkey);
    return () => { stop(); setNip07Scanning(false); };
  }, []);

  useEffect(() => {
    resetEligibilityFlow();
    if (npubIsValid && activeNpub && coordinatorInfo) {
      void checkNpubAccess();
    }
  }, [activeNpub, npubIsValid, coordinatorInfo]);

  function resetIssuanceFlow() {
    setMintQuote(null);
    setQuoteState(null);
    setPublishResult(null);
    setCurrentProof(null);
    setPollingQuote(false);
  }

  function resetEligibilityFlow() {
    setEligibilityResult(null);
    resetIssuanceFlow();
  }

  const checkNpubAccess = useCallback(async () => {
    if (!npubIsValid || !activeNpub) {
      setError("Connect a signer to derive your npub before checking eligibility.");
      return;
    }

    setLoading(true);
    setStatus(null);
    setError(null);
    resetEligibilityFlow();

    try {
      const payload = await checkEligibility(activeNpub);
      setEligibilityResult(payload);
      setStatus(payload.message);

      if (!payload.allowed) {
        window.alert("This npub is not in the eligible list.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Eligibility check failed");
    } finally {
      setLoading(false);
    }
  }, [npubIsValid, activeNpub]);

  const requestQuote = useCallback(async () => {
    if (!eligibilityResult?.canProceed) {
      setError("Check that your npub is eligible before requesting a quote.");
      return;
    }

    setRequestingQuote(true);
    setStatus(null);
    setError(null);
    resetIssuanceFlow();

    try {
      const quote = await createMintQuote();
      setMintQuote(quote);
      setQuoteState("UNPAID");

      storeWalletBundle({
        electionId: electionInfo?.election_id ?? "",
        ephemeralKeypair: { nsec: "", npub: "" },
        coordinatorProofs: [],
        election: electionInfo ? {
          electionId: electionInfo.election_id,
          title: electionInfo.title,
          questions: electionInfo.questions,
          vote_start: electionInfo.vote_start,
          vote_end: electionInfo.vote_end,
          mint_urls: electionInfo.mint_urls,
          coordinator_npubs: electionInfo.coordinator_npubs,
        } : null,
        relays
      });
      setWalletBundle(loadStoredWalletBundle());
      setStatus(`Quote ${quote.quote} created. Publish your claim to request approval.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not request quote");
    } finally {
      setRequestingQuote(false);
    }
  }, [eligibilityResult, electionInfo, coordinatorNpub, activeMintUrl, relays]);

  const publishInvoiceClaim = useCallback(async () => {
    if (!mintQuote) {
      setError("Request a quote first.");
      window.alert("Request a quote first.");
      return;
    }

    if (signerMode === "raw" && !derivedNpub) {
      setError("Enter a valid nsec to sign the claim.");
      window.alert("Enter a valid nsec to sign the claim.");
      return;
    }

    setPublishingClaim(true);
    setStatus(null);
    setError(null);

    try {
      let event;

      if (signer && signerMode === "nip07") {
        event = await signCashuClaimEvent(
          signer,
          coordinatorNpub,
          activeMintUrl,
          mintQuote.quote,
          mintQuote.request,
          electionId
        );
      } else {
        event = createCashuClaimEvent(
          nsecInput,
          coordinatorNpub,
          activeMintUrl,
          mintQuote.quote,
          mintQuote.request,
          electionId
        );
      }

      const result = await publishCashuClaim(relays, event);

      try {
        await logClaimDebug({
          npub: activeNpub ?? "",
          coordinatorNpub,
          mintApiUrl: activeMintUrl,
          relays,
          quoteId: mintQuote.quote,
          invoice: mintQuote.request,
          event: {
            id: event.id,
            pubkey: event.pubkey,
            kind: event.kind,
            created_at: event.created_at,
            content: event.content,
            tags: event.tags,
            sig: event.sig
          },
          publishResult: result
        });
      } catch {
        console.warn("[voter] failed to send claim debug log");
      }

      setPublishResult(result);
      setPollingQuote(true);

      if (result.failures > 0) {
        const failedRelayMessage = result.relayResults
          .filter((rr) => !rr.success)
          .map((rr) => `${rr.relay}: ${rr.error ?? "Unknown error"}`)
          .join("\n");
        window.alert(`Some relays rejected the claim publish:\n${failedRelayMessage}`);
      }

      if (result.successes > 0) {
        setStatus(`Claim published to ${result.successes} relay${result.successes === 1 ? "" : "s"}. Waiting for coordinator approval...`);
      } else {
        setStatus("Relay publish did not confirm. The coordinator may not see your claim.");
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Could not publish invoice claim";
      setError(message);
      window.alert(message);
    } finally {
      setPublishingClaim(false);
    }
  }, [mintQuote, derivedNpub, nsecInput, coordinatorNpub, activeMintUrl, electionId, relays, activeNpub, signer, signerMode]);

  const pollQuoteAndMint = useCallback(async () => {
    if (!mintQuote || !activeNpub) return;

    try {
      const started = await startIssuanceTracking({
        npub: activeNpub,
        quoteId: mintQuote.quote,
        electionId,
      });

      if (started.status === "already_issued") {
        setQuoteState("PAID");
      } else {
        const status = await awaitIssuanceStatus({ requestId: started.request_id, timeoutMs: 30000 });
        if (status.status === "timeout") {
          setStatus("Still waiting for coordinator approval. You can retry.");
          setPollingQuote(false);
          return;
        }
        setQuoteState(status.quote_state ?? "PAID");
      }

      setPollingQuote(false);
      setStatus("Pass approved. Minting your voting pass...");
      setMintingTokens(true);
      const mintResult = await requestQuoteAndMint(MINT_URL.replace(/\/$/, ""), mintQuote.quote);
      const proof = mintResult.proofs[0];

      if (proof) {
        setCurrentProof(proof);
        const coordinatorProof: CoordinatorProof = {
          coordinatorNpub,
          mintUrl: activeMintUrl,
          proof,
          proofSecret: (proof as any).secret ?? ""
        };
        addCoordinatorProof(coordinatorProof);
        setWalletBundle(loadStoredWalletBundle());
        setStatus(`Voting pass received.`);
      } else {
        setError("Mint returned no proofs.");
      }
    } catch (requestError) {
      if (!DEMO_MODE && mintQuote) {
        try {
          const status = await checkQuoteStatus(mintQuote.quote);
          setQuoteState(status.state);
        } catch {
          // ignore fallback failure
        }
      }
      setPollingQuote(false);
      setError(requestError instanceof Error ? requestError.message : "Quote status check failed");
    } finally {
      setMintingTokens(false);
    }
  }, [mintQuote, activeNpub, electionId, coordinatorNpub, activeMintUrl]);

  useEffect(() => {
    if (!pollingQuote || !mintQuote) return;
    void pollQuoteAndMint();
  }, [pollingQuote, mintQuote, pollQuoteAndMint]);

  const startMultiCoordinatorIssuance = useCallback(async () => {
    if (!electionInfo || !activeNpub) return;

    const coordinatorsToUse = discoveredCoordinators.length > 1
      ? discoveredCoordinators
      : [{ npub: coordinatorNpub, httpApi: "", mintUrl: activeMintUrl, relays }];

    setMultiIssuanceRunning(true);
    setIssuanceProgress({});
    setIssuanceErrors({});

    storeWalletBundle({
      electionId: electionInfo.election_id,
      ephemeralKeypair: { nsec: "", npub: "" },
      coordinatorProofs: [],
      election: {
        electionId: electionInfo.election_id,
        title: electionInfo.title,
        questions: electionInfo.questions,
        vote_start: electionInfo.vote_start,
        vote_end: electionInfo.vote_end,
        mint_urls: electionInfo.mint_urls,
        coordinator_npubs: coordinatorsToUse.map(c => c.npub),
        eligible_root: electionInfo.eligible_root,
        eligible_count: electionInfo.eligible_count,
      },
      relays
    });
    setWalletBundle(loadStoredWalletBundle());

    for (const coord of coordinatorsToUse) {
      const mintUrl = (coord.mintUrl || MINT_URL).replace(/\/$/, "");
      setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "requesting_quote" }));

      try {
        const quote = await createMintQuote(mintUrl);
        setMintQuote(quote);
        setQuoteState("UNPAID");
        setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "publishing_claim" }));

        let event;
        if (signer && signerMode === "nip07") {
          event = await signCashuClaimEvent(signer, coord.npub, mintUrl, quote.quote, quote.request, electionInfo.election_id);
        } else {
          event = createCashuClaimEvent(nsecInput, coord.npub, mintUrl, quote.quote, quote.request, electionInfo.election_id);
        }

        const result = await publishCashuClaim(relays, event);
        setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "polling" }));

        if (result.successes === 0) {
          setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "error" }));
          setIssuanceErrors(prev => ({ ...prev, [coord.npub]: "Claim publish failed on all relays" }));
          continue;
        }

        try {
          await logClaimDebug({
            npub: activeNpub ?? "",
            coordinatorNpub: coord.npub,
            mintApiUrl: mintUrl,
            relays,
            quoteId: quote.quote,
            invoice: quote.request,
            event: {
              id: event.id,
              pubkey: event.pubkey,
              kind: event.kind,
              created_at: event.created_at,
              content: event.content,
              tags: event.tags,
              sig: event.sig
            },
            publishResult: result
          });
        } catch {
          console.warn("[voter] failed to send claim debug log for", coord.npub);
        }

        let approved = false;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, USE_MOCK ? 2500 : 5000));
          const status = await checkQuoteStatus(quote.quote, mintUrl);
          setQuoteState(status.state);
          if (status.state === "PAID") {
            approved = true;
            break;
          }
        }

        if (!approved) {
          setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "error" }));
          setIssuanceErrors(prev => ({ ...prev, [coord.npub]: "Quote not approved within timeout" }));
          continue;
        }

        setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "minting" }));
        const mintResult = await requestQuoteAndMint(mintUrl, quote.quote);
        const proof = mintResult.proofs[0];

        if (proof) {
          const coordinatorProof: CoordinatorProof = {
            coordinatorNpub: coord.npub,
            mintUrl,
            proof,
            proofSecret: (proof as any).secret ?? "",
          };
          addCoordinatorProof(coordinatorProof);
          setWalletBundle(loadStoredWalletBundle());
          setCurrentProof(proof);
          setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "done" }));
        } else {
          setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "error" }));
          setIssuanceErrors(prev => ({ ...prev, [coord.npub]: "Mint returned no proofs" }));
        }
      } catch (err) {
        setIssuanceProgress(prev => ({ ...prev, [coord.npub]: "error" }));
        setIssuanceErrors(prev => ({ ...prev, [coord.npub]: err instanceof Error ? err.message : "Unknown error" }));
      }
    }

    setMultiIssuanceRunning(false);
    const finalBundle = loadStoredWalletBundle();
    const proofCount = finalBundle?.coordinatorProofs.length ?? 0;
    setStatus(`Issuance complete. ${proofCount} proof(s) obtained.`);
  }, [electionInfo, activeNpub, discoveredCoordinators, coordinatorNpub, activeMintUrl, relays, signer, signerMode, nsecInput]);

  const quoteStateLabel = quoteState === "UNPAID"
    ? "Waiting for coordinator approval"
    : quoteState === "PAID"
      ? "Proof ready"
    : quoteState === "ISSUED"
        ? "Proof issued"
        : null;

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div className="hero-brand">
          <img src="/images/logo.png" alt="" width={28} height={28} />
          <p className="eyebrow">Voter Portal</p>
        </div>
        <h1 className="hero-title">{DEMO_MODE ? "Verify eligibility and get your voting pass." : "Check your eligible npub and mint a Cashu voting proof."}</h1>
        <p className="hero-copy">
          {DEMO_MODE
            ? "Follow the guided flow: verify, request approval, and receive your voting pass. Advanced protocol details are available below."
            : "Enter an eligible `npub`, request a quote from the Mint API, sign that quote claim with your `nsec`, publish it to Nostr relays, then receive a proof into your local wallet."}
        </p>

        {discoveryLoading ? (
          <p className="field-hint hero-hint">Discovering coordinator...</p>
        ) : coordinatorInfo ? (
          <div className="hero-metadata">
            <span>Coordinator{discoveredCoordinators.length > 1 ? `s (${discoveredCoordinators.length})` : ""}</span>
            <code className="inline-code-badge">{coordinatorNpub.slice(0, 20)}...</code>
            {discoveredCoordinators.length > 1 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: "100%" }}>
                {discoveredCoordinators.map((c) => (
                  <code key={c.npub} className="inline-code-badge" style={{ fontSize: "0.75rem" }}>{c.npub.slice(0, 16)}...</code>
                ))}
              </div>
            )}
            <span><img className="inline-icon" src="/images/bitcoin-logo.png" alt="" width={18} height={18} />Mint</span>
            <code className="inline-code-badge">{activeMintUrl}</code>
            {allElections.length > 1 && (
              <select
                value={electionInfo?.election_id ?? ""}
                onChange={(e) => void handleElectionSelect(e.target.value)}
                disabled={electionsLoading}
                style={{
                  padding: "4px 8px",
                  borderRadius: 8,
                  border: "1px solid rgba(88,59,39,0.14)",
                  background: "rgba(255,255,255,0.64)",
                  fontSize: "0.85rem",
                  maxWidth: 260,
                }}
              >
                {allElections.map((e) => (
                  <option key={e.election_id} value={e.election_id}>
                    {e.title} ({new Date(e.start_time * 1000).toLocaleDateString()})
                  </option>
                ))}
              </select>
            )}
            {electionInfo && !electionsLoading && allElections.length <= 1 && (
              <>
                <span>Election</span>
                <code className="inline-code-badge">{electionInfo.title}</code>
              </>
            )}
            {electionInfo && electionInfo.vote_start > 0 && (
              <span className="field-hint">
                {formatDateTime(electionInfo.vote_start)} -- {formatDateTime(electionInfo.vote_end)}
              </span>
            )}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <img className="empty-state-image" src="/images/nostr/underconstruction-dark.png" alt="" width={160} />
            <p className="field-hint hero-hint" style={{ color: "var(--muted)" }}>
              Could not reach coordinator. Mock mode may be active.
            </p>
          </div>
        )}
        <img className="hero-accent-image" src="/images/black-hat.webp" alt="" width={140} />
      </section>

      <section className="content-grid">
        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Signer</p>
              <h2>Choose how to sign</h2>
            </div>
          </div>

          <div className="signer-mode-selector">
            <button
              type="button"
              className={`signer-mode-option${signerMode === "nip07" ? " active" : ""}`}
              onClick={() => {
                setSignerMode("nip07");
                try {
                  const s = createNip07Signer();
                  setSigner(s);
                } catch {
                  setSigner(null);
                }
              }}
            >
              Browser Extension
            </button>
            <button
              type="button"
              className={`signer-mode-option${signerMode === "raw" ? " active" : ""}`}
              onClick={() => {
                setSignerMode("raw");
                setSigner(null);
              }}
            >
              Paste nsec
            </button>
          </div>

          {signerMode === "nip07" && nip07Pubkey ? (
            <div className="signer-status">
              <span style={{ fontWeight: 700 }}>Connected</span>
              <code className="code-block code-block-muted" style={{ fontSize: "0.85rem", padding: "6px 10px" }}>{nip07Pubkey}</code>
              {activeNpub && (
                <div style={{ marginTop: 12 }}>
                  <div className="validation-row">
                    <span className={eligibilityResult?.canProceed ? "validation-ok" : eligibilityResult ? "validation-warn" : "validation-warn"}>
                      {eligibilityResult?.canProceed
                        ? "\u2713 Eligible npub confirmed"
                        : eligibilityResult && !eligibilityResult.canProceed
                          ? "\u2717 Not on the eligibility list"
                          : loading
                            ? "Checking eligibility..."
                            : "Checking whether this npub is on the eligible list"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : signerMode === "nip07" && nip07Scanning ? (
            <p className="empty-copy">Scanning for NIP-07 extension...</p>
          ) : signerMode === "nip07" ? (
            <p className="empty-copy">No NIP-07 extension detected. Install Alby, nos2x, or NostrKey, then reload.</p>
          ) : null}

          {signerMode === "raw" && (
            <>
              <div className="warning-box">
                <strong>Protect the nsec.</strong>
                <p>
                  `nsec` is your private key. Anyone who gets it can act as you. This page signs locally in the browser and never sends `nsec` to the coordinator or the mint API.
                </p>
              </div>

              <label className="field-label" htmlFor="nsec-input">nsec</label>
              <textarea
                id="nsec-input"
                className="text-area text-area-secret"
                value={nsecInput}
                onChange={(event) => setNsecInput(event.target.value)}
                placeholder="nsec1..."
                rows={4}
              />
              <p className="field-hint">
                Paste your `nsec`. The browser derives your `npub` locally.
              </p>

              {derivedNpub && (
                <div className="derived-box">
                  <p className="code-label">Derived npub</p>
                  <code className="code-block code-block-muted">{derivedNpub}</code>
                </div>
              )}

              {activeNpub && (
                <div style={{ marginTop: 16 }}>
                  <div className="validation-row">
                    <span className={eligibilityResult?.canProceed ? "validation-ok" : eligibilityResult ? "validation-warn" : "validation-warn"}>
                      {eligibilityResult?.canProceed
                        ? "\u2713 Eligible npub confirmed"
                        : eligibilityResult && !eligibilityResult.canProceed
                          ? "\u2717 Not on the eligibility list"
                          : loading
                            ? "Checking eligibility..."
                            : "Checking whether this npub is on the eligible list"}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          <img className="panel-accent-image" src="/images/nostr/gmnotes.png" alt="" width={120} />
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 2</p>
              <h2>{DEMO_MODE ? `Get your ${DEMO_COPY.pass}` : "Get your voter proof"}</h2>
            </div>
            {currentProof && <span className="count-pill">Proof received</span>}
            {quoteStateLabel && <span className="count-pill">{quoteStateLabel}</span>}
          </div>

          <div className="verification-grid">
            <div>
              <div className="substep-card">
                <p className="code-label">Step 2.1</p>
                <h3 className="substep-title">{DEMO_MODE ? "Request approval" : "Request quote from Mint"}</h3>
                <p className="field-hint substep-copy">
                  {discoveredCoordinators.length > 1
                    ? `Once eligible, request a proof from each of the ${discoveredCoordinators.length} coordinators.`
                    : "Once your npub passes the eligibility check, ask the Mint API for an issuance quote."}
                </p>
                <div className="button-row button-row-tight">
                  <button className="secondary-button" onClick={() => void requestQuote()} disabled={!canRequestQuote || multiIssuanceRunning}>
                    {requestingQuote ? "Requesting..." : (DEMO_MODE ? "Request voting pass" : "Request quote (single)")}
                  </button>
                  {discoveredCoordinators.length > 1 && (
                    <button className="primary-button" onClick={() => void startMultiCoordinatorIssuance()} disabled={!canRequestQuote || multiIssuanceRunning}>
                      {multiIssuanceRunning ? "Issuing from all coordinators..." : `Request from all ${discoveredCoordinators.length} coordinators`}
                    </button>
                  )}
                </div>
              </div>

              <div className="challenge-card challenge-card-spaced">
                <p className="code-label">Mint quote</p>
                {mintQuote ? (
                  <div className="detail-stack">
                    <code className="code-block code-block-muted">{mintQuote.request}</code>
                    <p className="field-hint">Quote: {mintQuote.quote}</p>
                    <p className="field-hint">{quoteStateLabel ?? "unknown"}</p>
                  </div>
                ) : (
                  <p className="empty-copy">No quote requested yet.</p>
                )}
              </div>
            </div>

            <div className="challenge-column">
              <div className="substep-card">
                <p className="code-label">Step 2.2</p>
                <h3 className="substep-title">Sign quote and publish</h3>
                <p className="field-hint substep-copy">
                  {signerMode === "nip07"
                    ? "Your browser extension will sign the claim. No private key is exposed to this page."
                    : "Your nsec will sign the claim locally and publish it to Nostr relays."}
                </p>
              </div>

              <div className="button-row">
                <button
                  className="primary-button"
                  onClick={() => void publishInvoiceClaim()}
                  disabled={
                    !mintQuote || publishingClaim ||
                    (signerMode === "raw" && !derivedNpub) ||
                    (signerMode === "nip07" && !signer)
                  }
                >
                  {publishingClaim ? "Publishing..." : (DEMO_MODE ? "Confirm request" : "Sign and publish claim")}
                </button>
              </div>

              <div className="validation-row">
                <span className={
                  signerMode === "nip07"
                    ? (signer ? "validation-ok" : "validation-warn")
                    : (derivedNpub ? "validation-ok" : "validation-warn")
                }>
                  {signerMode === "nip07"
                    ? (signer ? "Extension ready to sign" : "No extension connected")
                    : derivedNpub
                      ? "Signer ready"
                      : "Enter a valid nsec in the Signer panel"}
                </span>
              </div>

              {publishResult && (
                <div className="notice notice-success">
                  Claim event `{publishResult.eventId}` attempted on {publishResult.successes + publishResult.failures} relay{publishResult.successes + publishResult.failures === 1 ? "" : "s"}; {publishResult.successes} success, {publishResult.failures} failure.
                  {claimVerificationUrl && (
                    <a className="notice-link" href={claimVerificationUrl} target="_blank" rel="noreferrer">
                      Verify this claim event on njump
                    </a>
                  )}
                </div>
              )}

              {currentProof && (
                <div className="notice notice-success">
                  Proof received and stored as your single voting proof.
                </div>
              )}

              {discoveredCoordinators.length > 1 && Object.keys(issuanceProgress).length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <p className="code-label" style={{ marginBottom: 8 }}>Per-coordinator issuance progress</p>
                  {discoveredCoordinators.map((coord) => {
                    const state = issuanceProgress[coord.npub];
                    const errorMsg = issuanceErrors[coord.npub];
                    const stateLabel = state === "requesting_quote"
                      ? "Requesting quote..."
                      : state === "publishing_claim"
                        ? "Publishing claim..."
                        : state === "polling"
                          ? "Waiting for approval..."
                          : state === "minting"
                            ? "Minting proof..."
                            : state === "done"
                              ? "Proof received"
                              : state === "error"
                                ? "Failed"
                                : "Pending";
                    return (
                      <div key={coord.npub} style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 0",
                        borderBottom: "1px solid rgba(88,59,39,0.06)",
                      }}>
                        <span style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          fontSize: "0.7rem",
                          fontWeight: 700,
                          flexShrink: 0,
                          background: state === "done" ? "var(--accent)" : state === "error" ? "#e74c3c" : "rgba(88,59,39,0.08)",
                          color: state === "done" || state === "error" ? "#fff" : "var(--muted)",
                        }}>
                          {state === "done" ? "\u2713" : state === "error" ? "\u2717" : "\u2022"}
                        </span>
                        <code style={{ fontSize: "0.78rem", flexShrink: 0 }}>{coord.npub.slice(0, 20)}...</code>
                        <span className="field-hint" style={{ margin: 0, opacity: 0.7 }}>{stateLabel}</span>
                        {errorMsg && <span style={{ fontSize: "0.75rem", color: "#e74c3c" }}>{errorMsg}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Wallet</p>
              <h2>Your voting proof</h2>
            </div>
            <span className="count-pill">{walletBundle && walletBundle.coordinatorProofs.length > 0 ? `${walletBundle.coordinatorProofs.length} proof(s)` : "No proof"}</span>
          </div>

          {walletBundle && walletBundle.coordinatorProofs.length > 0 ? (
            <div className="derived-box">
              <p className="code-label">Proof</p>
              <code className="code-block code-block-muted">{JSON.stringify(walletBundle.coordinatorProofs.map(cp => cp.proof), null, 2)}</code>
              <p className="field-hint">Election {walletBundle.election?.electionId ?? "unknown"}</p>
              <p className="field-hint">Keyset {walletBundle.coordinatorProofs[0].proof.id}</p>
            </div>
          ) : (
            <p className="empty-copy">No proof stored yet. Request a quote, publish the signed claim, and wait for the mint proof.</p>
          )}

          {walletBundle && walletBundle.coordinatorProofs.length > 0 && (
            <div className="button-row">
              <a className="primary-button link-button cta-link-button" href="/vote.html">Go To Voting Page</a>
            </div>
          )}
        </article>

        {(status || error) && (
          <article className="panel panel-wide">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Latest update</p>
                <h2>Status</h2>
              </div>
            </div>
            {status && <div className="notice notice-success">{status}</div>}
            {error && <div className="notice notice-error">{error}</div>}
          </article>
        )}
      </section>
    </main>
  );
}
