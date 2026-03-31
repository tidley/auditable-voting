import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { finalizeEvent, getPublicKey, nip19, SimplePool } from "nostr-tools";
import {
  discoverCoordinators,
  fetchElection,
  fetchIssuanceStatus,
  fetchPublicLedger,
  fetchPerCoordinatorTallies,
  fetchResult,
  fetchTally,
  runAudit,
  type AuditResult,
  type CoordinatorDiscovery,
  type CoordinatorInfo,
  type ElectionInfo,
  type FinalResultInfo,
  type IssuanceStatusResponse,
  type PerCoordinatorTally,
  type PublicLedgerEntry,
  type PublicLedgerResponse,
  type TallyInfo,
} from "./coordinatorApi";
import { createMintQuote, checkQuoteStatus, type MintQuoteResponse } from "./mintApi";
import { requestQuoteAndMint, type CashuProof } from "./cashuBlind";
import {
  checkEligibility,
  fetchEligibility as fetchVoterEligibility,
  seedEligibility,
  type EligibilityCheckResponse,
  type EligibilityResponse,
} from "./voterManagementApi";
import { DEMO_MODE, USE_MOCK, MINT_URL, COORDINATOR_URL } from "./config";
import { decodeNsec, deriveNpubFromNsec, formatDateTime } from "./nostrIdentity";
import { createDemoIdentity, type DemoIdentity } from "./demoIdentity";
import { fetchCoordinatorInfo } from "./coordinatorApi";
import { computeProofHash, publishBallotEvent } from "./ballot";
import { submitProofsToAllCoordinators, type MultiCoordinatorDmResult } from "./proofSubmission";
import { queueNostrPublish } from "./nostrPublishQueue";
import TokenFingerprint from "./TokenFingerprint";
import PageNav from "./PageNav";

type StepState = {
  title: string;
  detail: string;
  status: "done" | "current" | "waiting";
};

type DemoVoteChoice = "Yes" | "No";

const DEMO_VOTER_COUNT = 3;

function buildDemoRoster(count = DEMO_VOTER_COUNT): DemoIdentity[] {
  return Array.from({ length: count }, () => createDemoIdentity());
}

const EMPTY_ELIGIBILITY: EligibilityResponse = {
  eligibleNpubs: [],
  eligibleCount: 0,
  verifiedNpubs: [],
  verifiedCount: 0,
};

function shortCode(value: string, head = 12, tail = 6): string {
  if (value.length <= head + tail + 3) {
    return value;
  }

  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function sortLedgerEntries(entries: PublicLedgerEntry[]): PublicLedgerEntry[] {
  return [...entries].sort((left, right) => {
    const leftIssuedAt = left.issuedAt ?? Number.MAX_SAFE_INTEGER;
    const rightIssuedAt = right.issuedAt ?? Number.MAX_SAFE_INTEGER;
    if (leftIssuedAt !== rightIssuedAt) {
      return leftIssuedAt - rightIssuedAt;
    }
    return left.proofHash.localeCompare(right.proofHash);
  });
}

function mergeLedgerEntries(
  remoteEntries: PublicLedgerEntry[],
  localEntries: PublicLedgerEntry[],
): PublicLedgerEntry[] {
  const merged = new Map<string, PublicLedgerEntry>();

  for (const entry of [...remoteEntries, ...localEntries]) {
    const existing = merged.get(entry.proofHash);
    merged.set(entry.proofHash, {
      npub: entry.npub ?? existing?.npub ?? null,
      proofHash: entry.proofHash,
      quoteId: entry.quoteId ?? existing?.quoteId ?? null,
      issuedAt: entry.issuedAt ?? existing?.issuedAt ?? null,
      ballotEventId: entry.ballotEventId ?? existing?.ballotEventId ?? null,
      voteChoice: entry.voteChoice ?? existing?.voteChoice ?? null,
      receiptReceivedAt: entry.receiptReceivedAt ?? existing?.receiptReceivedAt ?? null,
    });
  }

  return sortLedgerEntries([...merged.values()]);
}

function PanelTitle({ kicker, title, right }: { kicker: string; title: string; right?: ReactNode }) {
  return (
    <div className="demo-panel-title">
      <div>
        <div className="demo-kicker">{kicker}</div>
        <h2>{title}</h2>
      </div>
      {right}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="demo-metric">
      <div className="demo-kicker">{label}</div>
      <div className="demo-metric-value">{value}</div>
      <div className="demo-note">{hint}</div>
    </div>
  );
}

function CopyField({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`copy-field${compact ? " copy-field-compact" : ""}`}>
      <div className="copy-field-label">{label}</div>
      <code className="copy-field-value">{value}</code>
      <button className="copy-field-button" onClick={handleCopy} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function DemoApp() {
  const [voterRoster, setVoterRoster] = useState<DemoIdentity[]>(() => buildDemoRoster());
  const [selectedVoterIndex, setSelectedVoterIndex] = useState(0);
  const [nsecInput, setNsecInput] = useState<string>(() => voterRoster[0]?.nsec ?? "");
  const [selectedNpub, setSelectedNpub] = useState<string>(() => voterRoster[0]?.npub ?? "");
  const [voteChoice, setVoteChoice] = useState<DemoVoteChoice>("Yes");
  const [choiceByNpub, setChoiceByNpub] = useState<Record<string, DemoVoteChoice>>({});
  const [coordinatorInfo, setCoordinatorInfo] = useState<CoordinatorInfo | null>(null);
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityResponse>(EMPTY_ELIGIBILITY);
  const [issuanceStatus, setIssuanceStatus] = useState<IssuanceStatusResponse | null>(null);
  const [publicLedger, setPublicLedger] = useState<PublicLedgerResponse | null>(null);
  const [sessionLedger, setSessionLedger] = useState<Record<string, PublicLedgerEntry>>({});
  const [tally, setTally] = useState<TallyInfo | null>(null);
  const [finalResult, setFinalResult] = useState<FinalResultInfo | null>(null);
  const [discoveredCoordinators, setDiscoveredCoordinators] = useState<CoordinatorDiscovery[]>([]);
  const [perCoordinatorTallies, setPerCoordinatorTallies] = useState<PerCoordinatorTally[]>([]);
  const [auditResults, setAuditResults] = useState<AuditResult[]>([]);
  const [voterCheck, setVoterCheck] = useState<EligibilityCheckResponse | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [mintingProof, setMintingProof] = useState(false);
  const [publishingBallot, setPublishingBallot] = useState(false);
  const [submittingProof, setSubmittingProof] = useState(false);
  const [checkingVoter, setCheckingVoter] = useState(false);
  const [runningAudit, setRunningAudit] = useState(false);
  const [runningDemo, setRunningDemo] = useState(false);
  const [confirmingVote, setConfirmingVote] = useState(false);
  const [status, setStatus] = useState<string | null>("Loading live demo state...");
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [mintQuote, setMintQuote] = useState<MintQuoteResponse | null>(null);
  const [proof, setProof] = useState<CashuProof | null>(null);
  const [dmResults, setDmResults] = useState<MultiCoordinatorDmResult[] | null>(null);
  const [confirmationResult, setConfirmationResult] = useState<{ eventId: string; successes: number; failures: number } | null>(null);
  const [ballotEventId, setBallotEventId] = useState<string>("");
  const [, setBallotAnswers] = useState<Record<string, string | string[] | number>>({});
  const selectedVoter = voterRoster[selectedVoterIndex] ?? voterRoster[0] ?? null;
  const derivedNpub = useMemo(() => deriveNpubFromNsec(nsecInput), [nsecInput]);
  const activeQuestion = election?.questions[0] ?? null;
  const activePollResults = useMemo(() => {
    if (!activeQuestion) {
      return null;
    }

    return tally?.results[activeQuestion.id] ?? finalResult?.results?.[activeQuestion.id] ?? null;
  }, [activeQuestion, finalResult?.results, tally?.results]);
  const yesVotes = activePollResults?.Yes ?? activePollResults?.yes ?? 0;
  const noVotes = activePollResults?.No ?? activePollResults?.no ?? 0;
  const revealedLedgerEntries = useMemo(
    () => mergeLedgerEntries(publicLedger?.entries ?? [], Object.values(sessionLedger))
      .filter((entry) => !!entry.ballotEventId || !!entry.voteChoice || !!entry.receiptReceivedAt),
    [publicLedger?.entries, sessionLedger],
  );
  const revealedLedgerCount = revealedLedgerEntries.length;
  const revealedPendingBurnCount = revealedLedgerEntries.filter((entry) => !entry.receiptReceivedAt).length;
  const revealedBurnedCount = revealedLedgerCount - revealedPendingBurnCount;

  const eligibleNpubs = eligibility.eligibleNpubs;
  const issuedCount = Object.values(issuanceStatus?.voters ?? {}).filter((entry) => entry.issued).length;
  const publishedVotes = Math.max(tally?.total_published_votes ?? 0, finalResult?.total_votes ?? 0);
  const acceptedVotes = Math.max(tally?.total_accepted_votes ?? 0, finalResult?.total_votes ?? 0);
  const spentCommitmentRoot = tally?.spent_commitment_root || finalResult?.spent_commitment_root || "";
  const deliveredCoordinatorCount = dmResults?.filter((result) => result.result.successes > 0).length ?? 0;
  const deliveredRelayCount = dmResults?.reduce((sum, result) => sum + result.result.successes, 0) ?? 0;
  const confirmationCount = auditResults.length > 0 ? auditResults[0].confirmations : 0;
  const coordinatorCount = discoveredCoordinators.length || election?.coordinator_npubs.length || 0;
  const issuanceForSelected = selectedNpub ? issuanceStatus?.voters[selectedNpub] : undefined;
  const voteEnd = election?.vote_end ?? 0;
  const confirmEnd = election?.confirm_end ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const isInConfirmationWindow = voteEnd > 0 && now >= voteEnd && (confirmEnd === 0 || now <= confirmEnd);
  const votingWindowNotClosed = voteEnd > 0 && now < voteEnd;

  const patchSessionLedger = useCallback((proofHash: string, patch: Partial<PublicLedgerEntry>) => {
    if (!proofHash) {
      return;
    }

    setSessionLedger((prev) => {
      const current = prev[proofHash] ?? {
        npub: null,
        proofHash,
        quoteId: null,
        issuedAt: null,
        ballotEventId: null,
        voteChoice: null,
        receiptReceivedAt: null,
      };

      return {
        ...prev,
        [proofHash]: {
          ...current,
          ...patch,
          proofHash,
        },
      };
    });
  }, []);

  const timelinePhases: StepState[] = useMemo(() => {
    const spentRoot = spentCommitmentRoot;
    const spentRootShort = spentRoot ? `${spentRoot.slice(0, 24)}...` : "";
    const confirmationDetail = auditResults.length > 0
      ? `${confirmationCount} canonical confirmation(s) counted from real npubs.`
      : "After the voting window, voters publish kind 38013 from their real npub.";

    return [
      {
        title: "1. Election announced",
        detail: election
          ? `Election ${election.election_id} is live and visible to the demo.`
          : "Waiting for the coordinator to publish the election announcement.",
        status: election ? "done" : "current",
      },
      {
        title: "2. Proof minted",
        detail: proof
          ? `Minted proof for ${selectedNpub.slice(0, 18)}... is stored locally.`
          : voterCheck?.allowed
            ? `${voterCheck.npub} is eligible and can mint the proof.`
            : "Paste the nsec and mint the proof on this page.",
        status: proof ? "done" : election ? "current" : "waiting",
      },
      {
        title: "3. Ballot published",
        detail: ballotEventId
          ? `Ballot event ${ballotEventId.slice(0, 16)}... was published publicly.`
          : publishedVotes > 0
            ? `${publishedVotes} ballot event(s) are visible on the relay.`
            : "The ephemeral ballot key publishes kind 38000 on the relay.",
        status: ballotEventId || publishedVotes > 0 ? "done" : proof ? "current" : "waiting",
      },
      {
        title: "4. Proof delivered",
        detail: deliveredCoordinatorCount > 0
          ? `${deliveredCoordinatorCount} coordinator(s) received the proof gift wrap.`
          : dmResults && dmResults.length > 0
            ? "Proof delivery failed. No relay accepted the gift wrap."
          : issuedCount > 0
            ? `${issuedCount} proof(s) are ready to submit.`
            : "The proof is sent privately to the coordinator via gift wrap.",
        status: deliveredCoordinatorCount > 0 ? "done" : ballotEventId ? "current" : "waiting",
      },
      {
        title: "5. 38002 receipt published",
        detail: acceptedVotes > 0
          ? `Coordinator receipt seen. Auditors can reconstruct the spent commitment tree from those receipts.`
          : deliveredCoordinatorCount > 0
            ? "Waiting for the coordinator to publish kind 38002 after burning the proof."
            : "No receipt yet because proof delivery has not succeeded.",
        status: acceptedVotes > 0 ? "done" : deliveredCoordinatorCount > 0 ? "current" : "waiting",
      },
      {
        title: "6. Spent tree rebuilt",
        detail: spentRoot
          ? `Spent commitment root: ${spentRootShort}`
          : "Auditors rebuild the spent commitment tree from 38002 receipts as they appear.",
        status: spentRoot ? "done" : acceptedVotes > 0 ? "current" : "waiting",
      },
      {
        title: "7. 38013 confirmations",
        detail: confirmationResult
          ? `Confirmation event ${confirmationResult.eventId.slice(0, 16)}... was published to ${confirmationResult.successes} relay(s).`
          : confirmationDetail,
        status: confirmationResult || auditResults.length > 0 ? "done" : spentRoot ? "current" : "waiting",
      },
      {
        title: "8. Audit comparison",
        detail: auditResults.length > 0
          ? `Audit ran across ${auditResults.length} coordinator(s).`
          : "The verifier compares tally, confirmations, and the spent root.",
        status: auditResults.length > 0 ? "done" : confirmationResult ? "current" : "waiting",
      },
    ];
  }, [acceptedVotes, auditResults.length, ballotEventId, confirmationCount, confirmationResult, deliveredCoordinatorCount, dmResults, election, issuedCount, proof, publishedVotes, selectedNpub, spentCommitmentRoot, voterCheck]);

  const securityGuarantees = useMemo(() => {
    const ballotSideStatus: StepState["status"] =
      ballotEventId && acceptedVotes > 0 ? "done" : ballotEventId ? "current" : "waiting";
    const publicTotalsStatus: StepState["status"] =
      auditResults.length > 0 ? "done" : publishedVotes > 0 ? "current" : "waiting";
    const privacyStatus: StepState["status"] =
      ballotEventId && proof ? "done" : proof ? "current" : "waiting";
    const issuanceStatus: StepState["status"] =
      eligibleNpubs.length > 0 && issuedCount <= eligibleNpubs.length ? "done" : issuedCount > eligibleNpubs.length ? "current" : "waiting";
    const deniabilityStatus: StepState["status"] =
      confirmationResult ? "done" : isInConfirmationWindow ? "current" : "waiting";

    return [
      {
        title: "Counted on the correct side",
        status: ballotSideStatus,
        detail: ballotEventId
          ? `Ballot ${ballotEventId.slice(0, 16)}... has a receipt-backed tally entry. If the receipt were missing, this card would not turn green.`
          : "Publish the ballot and the proof receipt to show the vote is counted only once, on the public tally side.",
      },
      {
        title: "Anyone can recompute totals",
        status: publicTotalsStatus,
        detail: auditResults.length > 0
          ? `The verifier already ran the public comparison across ${auditResults.length} coordinator(s).`
          : "The same public ballot events and receipts can be re-read by anyone to compute the totals and the winner.",
      },
      {
        title: "Nobody can see who voted for what",
        status: privacyStatus,
        detail: confirmationResult
          ? "The 38013 confirmation proves participation only. It does not reveal the ballot choice or carry the vote content."
          : "The ballot is separate from the confirmation step, so the public confirmation does not disclose the chosen option.",
      },
      {
        title: "No overissue",
        status: issuanceStatus,
        detail: `${issuedCount} issued pass${issuedCount === 1 ? "" : "es"} for ${eligibleNpubs.length} eligible voter${eligibleNpubs.length === 1 ? "" : "s"}. Any overissue would show up as a mismatch here and on the verifier card.`,
      },
      {
        title: "Vote is deniable",
        status: deniabilityStatus,
        detail: confirmationResult
          ? "The public confirmation proves you participated. It does not prove which side you picked, so it is not a transferable receipt for a vote sale."
          : "Publishing a confirmation is about participation counts, not about proving a particular vote choice to a third party.",
      },
    ];
  }, [acceptedVotes, auditResults.length, ballotEventId, confirmationResult, eligibleNpubs.length, isInConfirmationWindow, issuedCount, proof, publishedVotes]);

  const refreshSnapshot = useCallback(async (showSpinner = true) => {
    if (showSpinner) setRefreshing(true);

    try {
      const [info, elig, electionResult, tallyResult, resultResult, issuanceResult, publicLedgerResult] = await Promise.all([
        fetchCoordinatorInfo(),
        fetchVoterEligibility(),
        fetchElection(),
        fetchTally(),
        fetchResult(),
        fetchIssuanceStatus(),
        fetchPublicLedger(),
      ]);

      setCoordinatorInfo(info);
      setEligibility(elig);
      setElection(electionResult);
      setTally(tallyResult);
      setFinalResult(resultResult);
      setIssuanceStatus(issuanceResult);
      setPublicLedger(publicLedgerResult);

      let coordinators: CoordinatorDiscovery[] = [];
      if (electionResult?.event_id) {
        coordinators = await discoverCoordinators(electionResult.event_id, info.relays);
      }
      setDiscoveredCoordinators(coordinators);
      if (coordinators.length > 0) {
        setPerCoordinatorTallies(await fetchPerCoordinatorTallies(coordinators));
      } else {
        setPerCoordinatorTallies([]);
      }

      setLastRefresh(Date.now());
      setStatus(`Synced live state for ${electionResult?.title ?? "the current election"}.`);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reach demo services");
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  const resetActiveVoterState = useCallback(() => {
    setMintQuote(null);
    setProof(null);
    setDmResults(null);
    setConfirmationResult(null);
    setBallotEventId("");
    setBallotAnswers({});
    setVoterCheck(null);
  }, []);

  const activateVoter = useCallback((roster: DemoIdentity[], index: number, choice?: DemoVoteChoice) => {
    const voter = roster[index];
    if (!voter) {
      return;
    }

    setVoterRoster(roster);
    setSelectedVoterIndex(index);
    setNsecInput(voter.nsec);
    setSelectedNpub(voter.npub);
    const nextChoice = choice ?? "Yes";
    setVoteChoice(nextChoice);
    setChoiceByNpub((prev) => ({ ...prev, [voter.npub]: nextChoice }));
    resetActiveVoterState();
  }, [resetActiveVoterState]);

  const seedDemoVoter = useCallback(async () => {
    setSeeding(true);
    setError(null);

    try {
      const nextRoster = buildDemoRoster();
      if (USE_MOCK) {
        for (const voter of nextRoster) {
          await seedEligibility(voter.npub);
        }
      }
      activateVoter(nextRoster, 0, "Yes");
      setStatus(`Generated ${nextRoster.length} voter identities.`);
      await refreshSnapshot(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to seed demo voters");
    } finally {
      setSeeding(false);
    }
  }, [activateVoter, refreshSnapshot]);

  useEffect(() => {
    void refreshSnapshot();
    void seedDemoVoter();
  }, [refreshSnapshot, seedDemoVoter]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshSnapshot(false);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [refreshSnapshot]);

  const checkSelectedVoter = useCallback(async () => {
    if (!selectedNpub.trim()) {
      setError("Paste an npub first.");
      return;
    }

    setCheckingVoter(true);
    setError(null);

    try {
      const result = await checkEligibility(selectedNpub.trim());
      setVoterCheck(result);
      setStatus(result.message);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Eligibility check failed");
    } finally {
      setCheckingVoter(false);
    }
  }, [selectedNpub]);

  const saveDemoIdentity = useCallback(async () => {
    const trimmedNsec = nsecInput.trim();
    const secretKey = decodeNsec(trimmedNsec);
    const npub = derivedNpub;
    if (!npub) {
      setError("Paste a valid nsec first.");
      return;
    }
    if (!secretKey) {
      setError("Paste a valid nsec first.");
      return;
    }

    setSeeding(true);
    setError(null);

    try {
      const nextIdentity: DemoIdentity = {
        nsec: trimmedNsec,
        npub,
        pubkey: getPublicKey(secretKey),
      };

      const existingIndex = voterRoster.findIndex((voter) => voter.npub === npub);
      const nextRoster = existingIndex >= 0
        ? voterRoster.map((voter, index) => index === existingIndex ? nextIdentity : voter)
        : [...voterRoster, nextIdentity];

      setVoterRoster(nextRoster);
      setSelectedVoterIndex(existingIndex >= 0 ? existingIndex : nextRoster.length - 1);
      setSelectedNpub(npub);
      setVoteChoice(choiceByNpub[npub] ?? "Yes");
      setChoiceByNpub((prev) => ({ ...prev, [npub]: choiceByNpub[npub] ?? "Yes" }));

      if (USE_MOCK) {
        await seedEligibility(npub);
      }
      resetActiveVoterState();
      setVoterCheck({
        npub,
        allowed: true,
        canProceed: true,
        message: "npub is allowed and has not voted yet",
      });
      setStatus(`Saved voter identity for ${npub}.`);
      await refreshSnapshot(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save identity");
    } finally {
      setSeeding(false);
    }
  }, [choiceByNpub, derivedNpub, nsecInput, refreshSnapshot, resetActiveVoterState, voterRoster]);

  const fillDemoBallot = useCallback((choice: DemoVoteChoice = voteChoice) => {
    if (!election?.questions) return {};

    const filled: Record<string, string | string[] | number> = {};
    for (const question of election.questions) {
      if (question.type === "choice") {
        filled[question.id] = choice;
      } else if (question.type === "scale") {
        filled[question.id] = question.min ?? 1;
      } else {
        filled[question.id] = "demo answer";
      }
    }

    setBallotAnswers(filled);
    return filled;
  }, [election, voteChoice]);

  const mintDemoProof = useCallback(async (nsecValue = nsecInput) => {
    const npub = deriveNpubFromNsec(nsecValue);
    if (!npub) {
      setError("Paste a valid nsec first.");
      return;
    }

    setMintingProof(true);
    setError(null);

    try {
      setNsecInput(nsecValue);
      setSelectedNpub(npub);

      if (USE_MOCK) {
        await seedEligibility(npub);
      }

      const eligibilityCheck = await checkEligibility(npub);
      setVoterCheck(eligibilityCheck);
      setStatus(eligibilityCheck.message);

      if (!eligibilityCheck.canProceed) {
        throw new Error(eligibilityCheck.message);
      }

      const quote = await createMintQuote();
      setMintQuote(quote);

      for (let i = 0; i < 20; i++) {
        const quoteStatus = await checkQuoteStatus(quote.quote);
        if (quoteStatus.state === "PAID") {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      const mintResult = await requestQuoteAndMint(MINT_URL.replace(/\/$/, ""), quote.quote);
      const mintedProof = mintResult.proofs[0] ?? null;
      if (!mintedProof) {
        throw new Error("Mint did not return a proof.");
      }

      patchSessionLedger(await computeProofHash(mintedProof.secret), {
        npub,
        quoteId: quote.quote,
        issuedAt: Date.now(),
        ballotEventId: null,
        voteChoice: null,
        receiptReceivedAt: null,
      });
      setProof(mintedProof);
      setConfirmationResult(null);
      setStatus("Proof minted and ready for the ballot step.");
      await refreshSnapshot(false);
      return mintedProof;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to mint proof");
      return null;
    } finally {
      setMintingProof(false);
    }
  }, [nsecInput, patchSessionLedger, refreshSnapshot]);

  const publishDemoBallot = useCallback(async (choice = voteChoice, nsecValue = nsecInput, proofInput = proof) => {
    const npub = deriveNpubFromNsec(nsecValue);
    if (!election || !proofInput || !npub) {
      setError("Mint a proof before publishing the ballot.");
      return null;
    }

    setNsecInput(nsecValue);
    setSelectedNpub(npub);
    setVoteChoice(choice);
    setChoiceByNpub((prev) => ({ ...prev, [npub]: choice }));

    const answers = fillDemoBallot(choice);
    const coordinatorNpub = election.coordinator_npubs[0] ?? coordinatorInfo?.coordinatorNpub ?? "";
    const relays = coordinatorInfo?.relays ?? [];

    setPublishingBallot(true);
    setError(null);

    try {
      const publishResult = await publishBallotEvent({
        electionId: election.election_id,
        answers,
        questions: election.questions,
        relays,
        coordinatorProofs: [{
          coordinatorNpub,
          mintUrl: election.mint_urls[0] ?? MINT_URL,
          proof: proofInput,
          proofSecret: proofInput.secret,
        }],
      });

      patchSessionLedger(await computeProofHash(proofInput.secret), {
        npub,
        ballotEventId: publishResult.eventId,
        voteChoice: choice,
      });
      setBallotEventId(publishResult.eventId);
      setConfirmationResult(null);
      setStatus(`Ballot published: ${publishResult.successes} relay confirmation(s).`);
      setIssuanceStatus((prev) => prev);
      return publishResult;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to publish ballot");
      return null;
    } finally {
      setPublishingBallot(false);
    }
  }, [coordinatorInfo?.coordinatorNpub, coordinatorInfo?.relays, election, fillDemoBallot, nsecInput, patchSessionLedger, proof, voteChoice]);

  const submitDemoProof = useCallback(async (ballotId = ballotEventId, nsecValue = nsecInput, proofInput = proof) => {
    if (!election || !ballotId || !proofInput) {
      setError("Mint a proof and publish a ballot before submitting the proof.");
      return null;
    }

    const voterSecretKey = decodeNsec(nsecValue);
    if (!voterSecretKey) {
      setError("Could not decode the saved nsec.");
      return null;
    }

    const coordinatorNpub = election.coordinator_npubs[0] ?? coordinatorInfo?.coordinatorNpub ?? "";
    const relays = coordinatorInfo?.relays ?? [];

    setSubmittingProof(true);
    setError(null);

    try {
      const dmOutcome = await submitProofsToAllCoordinators({
        voterSecretKey,
        voteEventId: ballotId,
        coordinatorProofs: [{
          coordinatorNpub,
          proof: proofInput,
        }],
        relays,
        retries: DEMO_MODE ? 1 : 0,
      });

      setDmResults(dmOutcome);
      const successfulCoordinators = dmOutcome.filter((result) => result.result.successes > 0).length;
      const successfulRelays = dmOutcome.reduce((sum, result) => sum + result.result.successes, 0);
      if (successfulCoordinators === 0) {
        throw new Error("Proof delivery failed. No relay accepted the NIP-17 gift wrap, so no 38002 receipt can appear.");
      }
      patchSessionLedger(await computeProofHash(proofInput.secret), {
        receiptReceivedAt: Date.now(),
      });
      setStatus(`Proof sent to ${successfulCoordinators} coordinator(s) across ${successfulRelays} relay confirmation(s).`);

      await refreshSnapshot(false);
      return dmOutcome;
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to submit proof");
      return null;
    } finally {
      setSubmittingProof(false);
    }
  }, [ballotEventId, coordinatorInfo?.coordinatorNpub, coordinatorInfo?.relays, election, nsecInput, patchSessionLedger, proof, refreshSnapshot]);

  const runVerifierAudit = useCallback(async () => {
    if (!election?.event_id) {
      setError("Need a discovered election before running an audit.");
      return;
    }

    setRunningAudit(true);
    setError(null);

    try {
      const coordinatorsToAudit = discoveredCoordinators.length > 0
        ? discoveredCoordinators
        : coordinatorInfo
          ? [{
              npub: coordinatorInfo.coordinatorNpub,
              httpApi: COORDINATOR_URL,
              mintUrl: coordinatorInfo.relays[0] ?? MINT_URL,
              relays: coordinatorInfo.relays,
            }]
          : [];

      if (coordinatorsToAudit.length === 0) {
        throw new Error("Need coordinator details before running an audit.");
      }

      const audit = await runAudit(
        election.event_id,
        coordinatorsToAudit,
        eligibility.eligibleNpubs,
        election.vote_start,
        election.confirm_end ?? election.vote_end + 86400,
        coordinatorInfo?.relays ?? [],
      );

      setAuditResults(audit);
      setStatus(`Audit complete for ${audit.length} coordinator(s).`);
    } catch (auditError) {
      setError(auditError instanceof Error ? auditError.message : "Audit failed");
    } finally {
      setRunningAudit(false);
    }
  }, [coordinatorInfo, discoveredCoordinators, election, eligibility.eligibleNpubs]);

  const publishDemoConfirmation = useCallback(async (ballotId = ballotEventId, nsecValue = nsecInput) => {
    if (!election || !ballotId || !nsecValue.trim()) {
      setError("Publish the ballot and save your nsec first.");
      return;
    }

    if (!isInConfirmationWindow) {
      setError("The confirmation window is not open yet.");
      return;
    }

    const secretKey = decodeNsec(nsecValue.trim());
    if (!secretKey) {
      setError("That nsec is not valid.");
      return;
    }

    setConfirmingVote(true);
    setError(null);
    setStatus(null);

    try {
      const confirmationCreatedAt = Math.floor(Date.now() / 1000);
      const event = finalizeEvent(
        {
          kind: 38013,
          created_at: confirmationCreatedAt,
          tags: [
            ["e", ballotId],
            ...election.coordinator_npubs.map((npub) => {
              const decoded = nip19.decode(npub);
              if (decoded.type !== "npub") {
                throw new Error("Coordinator value must be an npub.");
              }
              return ["p", decoded.data as string] as string[];
            }),
          ],
          content: JSON.stringify({
            action: "voter_confirmation",
            ballot_event_id: ballotId,
            election_id: election.election_id,
          }),
        },
        secretKey,
      );

      const publicRelays = (coordinatorInfo?.relays ?? []).filter((relay) => relay.startsWith("wss://"));
      const pool = new SimplePool();
      try {
        const results = await queueNostrPublish(() =>
          Promise.allSettled(pool.publish(publicRelays, event, { maxWait: 4000 })),
        );
        const successes = results.filter((result) => result.status === "fulfilled").length;
        const failures = results.length - successes;
        setConfirmationResult({ eventId: event.id, successes, failures });
        setStatus(`Voter confirmation (kind 38013) published to ${successes} relay(s).`);
      } finally {
        pool.destroy();
      }
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Could not publish voter confirmation");
    } finally {
      setConfirmingVote(false);
    }
  }, [ballotEventId, coordinatorInfo?.relays, election, isInConfirmationWindow, nsecInput]);

  const runDemoSequence = useCallback(async () => {
    if (runningDemo) return;

    setRunningDemo(true);
    setError(null);

    try {
      const voters = voterRoster.length > 0 ? voterRoster : buildDemoRoster();
      for (const [index, voter] of voters.entries()) {
        const choice: DemoVoteChoice = Math.random() < 0.5 ? "Yes" : "No";
        activateVoter(voters, index, choice);
        if (USE_MOCK) {
          await seedEligibility(voter.npub);
        }

        setStatus(`Step 1: voter ${index + 1}/${voters.length} selected (${choice})...`);
        const eligibilityCheck = await checkEligibility(voter.npub);
        if (!eligibilityCheck.canProceed) {
          throw new Error(eligibilityCheck.message);
        }
        setVoterCheck(eligibilityCheck);

        setStatus(`Step 2: minting proof for voter ${index + 1}/${voters.length}...`);
        const mintedProof = await mintDemoProof(voter.nsec);
        if (!mintedProof) {
          throw new Error("Mint did not return a proof.");
        }

        setStatus(`Step 3: publishing ${choice} ballot for voter ${index + 1}/${voters.length}...`);
        const publishResult = await publishDemoBallot(choice, voter.nsec, mintedProof);
        if (!publishResult) {
          throw new Error("Ballot publish failed.");
        }
        setBallotEventId(publishResult.eventId);

        setStatus(`Step 4: sending proof for voter ${index + 1}/${voters.length}...`);
        const dmOutcome = await submitDemoProof(publishResult.eventId, voter.nsec, mintedProof);
        if (!dmOutcome) {
          throw new Error("Proof delivery failed.");
        }

        if (isInConfirmationWindow) {
          setStatus(`Step 5: publishing confirmation for voter ${index + 1}/${voters.length}...`);
          await publishDemoConfirmation(publishResult.eventId, voter.nsec);
        }

        await refreshSnapshot(false);
      }

      setStatus("Step 6: running verifier audit...");
      await runVerifierAudit();
      setStatus("Demo complete. Every voter has run through the live flow.");
    } catch (sequenceError) {
      setError(sequenceError instanceof Error ? sequenceError.message : "Demo sequence failed");
    } finally {
      setRunningDemo(false);
    }
  }, [activateVoter, election, isInConfirmationWindow, mintDemoProof, publishDemoBallot, publishDemoConfirmation, refreshSnapshot, runVerifierAudit, runningDemo, seedEligibility, submitDemoProof, voterRoster]);

  return (
    <main className="page-shell page-shell-demo demo-app-shell">
      <aside className="demo-sidebar">
        <div className="demo-brand-block">
          <div className="demo-brand-title">AUDITABLE-VOTING</div>
          <div className="demo-brand-subtitle">NOSTR+CASHU PROTOCOL</div>
        </div>
        <PageNav current="home" />

        <div className="demo-sidebar-card">
          <div className="demo-sidebar-card-head">
            <div>
              <div className="demo-kicker">Identity</div>
              <div className="demo-sidebar-card-title">Ephemeral voter keypair</div>
            </div>
            <span className={`status-pill ${derivedNpub ? "status-pill-good" : "status-pill-neutral"}`}>
              {derivedNpub ? "Connected" : "Not Connected"}
            </span>
          </div>
          <div className="demo-sidebar-card-body">
            <div className="demo-sidebar-status-label">Voter identity</div>
            <div className="demo-sidebar-status-value">
              {derivedNpub ? `${selectedNpub.slice(0, 12)}...` : "No identity"}
            </div>
            <div className="demo-sidebar-status-hint">
              {derivedNpub ? `Ready for minting and ballot signing. Voter ${selectedVoterIndex + 1} of ${voterRoster.length}.` : "Paste or generate an nsec to begin."}
            </div>
          </div>
          <button className="primary-button demo-sidebar-cta" onClick={() => void seedDemoVoter()} disabled={seeding}>
            {seeding ? "Generating..." : "Generate voters"}
          </button>
        </div>

        <nav className="demo-sidebar-nav" aria-label="Sections">
          <a className="demo-sidebar-nav-item is-active" href="#demo-coordinator">Coordinator</a>
          <a className="demo-sidebar-nav-item" href="#demo-voter">Voter</a>
          <a className="demo-sidebar-nav-item" href="#demo-verifier">Verifier</a>
          <a className="demo-sidebar-nav-item" href="#demo-audit">Global Audit</a>
        </nav>

        <div className="demo-sidebar-footer">
          <div className="demo-kicker">Election ID</div>
          <div className="demo-sidebar-footer-value">
            <code>{election?.election_id ?? "Pending"}</code>
          </div>
          <div className="demo-sidebar-footer-links">
            <a href="#demo-status">System Status</a>
            <a href="#demo-guide">Documentation</a>
          </div>
        </div>
      </aside>

      <div className="demo-workspace">
        <header className="demo-header demo-header-ops">
          <div className="demo-top-tabs" aria-label="Workspace tabs">
            <a className="demo-top-tab is-active" href="#demo-coordinator">Operational_Ledger_V1</a>
            <a className="demo-top-tab" href="#demo-audit">Mempool</a>
            <a className="demo-top-tab" href="#demo-verifier">Relays</a>
            <a className="demo-top-tab" href="#demo-voter">Nodes</a>
          </div>
          <div className="demo-header-meta">
            <div className="demo-meta-row">
              <span>Identity</span>
              <strong>{derivedNpub ? `${selectedNpub.slice(0, 8)}...${selectedNpub.slice(-4)}` : "Not Connected"}</strong>
            </div>
            <div className="demo-meta-row">
              <span>Mode</span>
              <strong>{DEMO_MODE ? "Demo" : "Live"}</strong>
            </div>
            <div className="demo-meta-row">
              <span>Backend</span>
              <strong>{USE_MOCK ? "Mock server" : "Coordinator API"}</strong>
            </div>
            <button className="ghost-button" onClick={() => void refreshSnapshot()} disabled={refreshing}>
              {refreshing ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        {error && <section className="demo-banner demo-banner-error" id="demo-status">{error}</section>}
        {status && <section className="demo-banner" id="demo-status">{status}</section>}

        <section className="demo-ledger-section">
          <article className="demo-card demo-ledger-card" id="demo-ledger">
            <PanelTitle
              kicker="Reveal Ledger"
              title="Revealed proofs and public ballots"
              right={(
                <span className={`demo-status${revealedLedgerCount > 0 ? " demo-status-good" : ""}`}>
                  {revealedLedgerCount} revealed
                </span>
              )}
            />
            <div className="demo-note">
              In the real protocol, proof hashes are not public during issuance. This table only fills after a voter reveals a proof hash through ballot publication and proof submission, while issuance remains visible only as aggregate counts.
            </div>
            <div className="demo-ledger-summary">
              <div className="demo-ledger-summary-item">
                <span>Eligible voters</span>
                <strong>{eligibility.eligibleCount}</strong>
              </div>
              <div className="demo-ledger-summary-item">
                <span>Issued passes</span>
                <strong>{issuedCount}</strong>
              </div>
              <div className="demo-ledger-summary-item">
                <span>Revealed proofs</span>
                <strong>{revealedLedgerCount}</strong>
              </div>
              <div className="demo-ledger-summary-item">
                <span>Burn receipts</span>
                <strong>{revealedBurnedCount}</strong>
              </div>
            </div>
            <div className="demo-ledger-table-wrap">
              <table className="demo-ledger-table" aria-label="Revealed proof ledger">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Pattern</th>
                    <th scope="col">Proof hash</th>
                    <th scope="col">Ballot</th>
                    <th scope="col">Vote</th>
                    <th scope="col">Burn receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {revealedLedgerEntries.length > 0 ? revealedLedgerEntries.map((entry, index) => (
                    <tr key={entry.proofHash} className={!entry.receiptReceivedAt ? "is-pending" : ""}>
                      <td>{index + 1}</td>
                      <td><TokenFingerprint tokenId={entry.proofHash} compact label={`Public ballot fingerprint ${index + 1}`} /></td>
                      <td><code>{shortCode(entry.proofHash, 18, 10)}</code></td>
                      <td><code>{entry.ballotEventId ? shortCode(entry.ballotEventId, 10, 8) : "Waiting"}</code></td>
                      <td>
                        <span
                          className={`demo-ledger-vote-pill${
                            entry.voteChoice === "Yes"
                              ? " is-yes"
                              : entry.voteChoice === "No"
                                ? " is-no"
                                : " is-pending"
                          }`}
                        >
                          {entry.voteChoice ?? "Pending"}
                        </span>
                      </td>
                      <td>
                        <span className={`demo-ledger-receipt${entry.receiptReceivedAt ? " is-received" : ""}`}>
                          {entry.receiptReceivedAt ? "Received" : "Waiting"}
                        </span>
                      </td>
                    </tr>
                  )) : (
                    <tr className="is-pending">
                      <td colSpan={6}>
                        No proof hashes visible yet. In the real protocol they only appear after the voter reveals them.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>

        <section className="demo-grid demo-grid-4 demo-stat-grid-ops">
          <Metric label="Coordinators" value={coordinatorCount} hint="Discovered for the election." />
          <Metric label="Eligible voters" value={eligibility.eligibleCount} hint="Canonical voter list." />
          <Metric label="Issued passes" value={issuedCount} hint="Proofs stored locally." />
          <Metric label="Accepted ballots" value={acceptedVotes} hint="Vote results visible on the verifier." />
        </section>

        <section className="demo-console-grid">
          <article className="demo-card demo-console-card" id="demo-coordinator">
            <PanelTitle kicker="Coordinator" title="Current election" right={election?.event_id ? <span className="demo-status demo-status-good">Active Mint</span> : <span className="demo-status">Waiting</span>} />
            {election ? (
              <div className="demo-stack">
                <div className="demo-console-field">
                  <div className="demo-label">Publish election (kind 38008)</div>
                  <code>{election.election_id.slice(0, 6)}...{election.event_id.slice(-4)}</code>
                </div>
                <div className="demo-console-field">
                  <div className="demo-label">Proof issuance</div>
                  <div className="demo-console-progress">
                    <span>{issuedCount}</span>
                    <span>/</span>
                    <span>{eligibility.eligibleCount || "?"}</span>
                  </div>
                  <div className="demo-note">Waiting for voter commitments...</div>
                </div>
                <div className="demo-console-actions">
                  <button className="secondary-button" onClick={() => void seedDemoVoter()} disabled={seeding}>{seeding ? "Generating..." : "Generate voters"}</button>
                  <button className="ghost-button" onClick={() => void mintDemoProof()} disabled={mintingProof || !derivedNpub}>{mintingProof ? "Minting..." : "Mint proof"}</button>
                </div>
                <div className="demo-console-grid-small">
                  <div className="demo-console-tile">
                    <div className="demo-label">Receipts</div>
                    <div className="demo-console-tile-value">38002</div>
                  </div>
                  <div className="demo-console-tile">
                    <div className="demo-label">Run tally</div>
                    <div className="demo-console-tile-value">{runningAudit ? "..." : "Ready"}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="demo-console-empty">
                <div className="demo-note">No election loaded.</div>
                <div className="demo-note">Input an Election ID or Event ID to begin the audit session.</div>
              </div>
            )}
          </article>

          <article className="demo-card demo-console-card" id="demo-voter">
            <PanelTitle kicker="Voter" title="Eligibility and ballot" right={issuanceForSelected?.issued ? <span className="demo-status demo-status-good">Eligible</span> : <span className="demo-status">Ready</span>} />
            <div className="demo-stack">
              <div className="demo-console-field">
                <div className="demo-label">Select voter</div>
                <select
                  id="demo-voter-select"
                  className="demo-input demo-input-dark"
                  value={selectedVoterIndex}
                  onChange={(event) => {
                    const nextIndex = Number(event.target.value);
                    const nextRoster = voterRoster;
                    const nextVoter = nextRoster[nextIndex];
                    if (!nextVoter) return;
                    setSelectedVoterIndex(nextIndex);
                    setNsecInput(nextVoter.nsec);
                    setSelectedNpub(nextVoter.npub);
                    setVoteChoice(choiceByNpub[nextVoter.npub] ?? "Yes");
                    resetActiveVoterState();
                  }}
                >
                  {voterRoster.map((voter, index) => (
                    <option key={voter.npub} value={index}>
                      Voter {index + 1} • {voter.npub.slice(0, 12)}... • {choiceByNpub[voter.npub] ?? "Yes"}
                    </option>
                  ))}
                </select>
                <div className="demo-note">Switch the view to see what each voter can do.</div>
              </div>
              <div className="demo-console-field">
                <div className="demo-label">Connect nsec</div>
                <textarea
                  id="demo-nsec"
                  className="demo-input demo-input-dark"
                  value={nsecInput}
                  onChange={(event) => setNsecInput(event.target.value)}
                  rows={3}
                  spellCheck={false}
                />
                <div className="demo-note">Paste the voter key here to save it locally.</div>
              </div>
              <div className="demo-console-field" id="demo-poll">
                <div className="demo-label">Simple poll</div>
                <div className="demo-poll-toggle" role="group" aria-label="Vote choice">
                  <button
                    type="button"
                    className={`demo-poll-option${voteChoice === "Yes" ? " is-active" : ""}`}
                    onClick={() => {
                      setVoteChoice("Yes");
                      if (selectedNpub) {
                        setChoiceByNpub((prev) => ({ ...prev, [selectedNpub]: "Yes" }));
                      }
                      fillDemoBallot("Yes");
                    }}
                  >
                    Yes
                  </button>
                  <button
                    type="button"
                    className={`demo-poll-option${voteChoice === "No" ? " is-active" : ""}`}
                    onClick={() => {
                      setVoteChoice("No");
                      if (selectedNpub) {
                        setChoiceByNpub((prev) => ({ ...prev, [selectedNpub]: "No" }));
                      }
                      fillDemoBallot("No");
                    }}
                  >
                    No
                  </button>
                </div>
                <div className="demo-note">{activeQuestion?.prompt ?? "Should the proposal pass?"}</div>
              </div>
              <div className="button-row">
                <button className="primary-button" onClick={() => void mintDemoProof()} disabled={mintingProof || !derivedNpub}>
                  {mintingProof ? "Minting..." : "Mint proof"}
                </button>
                <button className="secondary-button" onClick={() => void publishDemoBallot(voteChoice)} disabled={publishingBallot || !proof || !derivedNpub}>
                  {publishingBallot ? "Publishing..." : "Publish ballot"}
                </button>
                <button className="ghost-button" onClick={() => void submitDemoProof()} disabled={submittingProof || !ballotEventId || !proof}>
                  {submittingProof ? "Submitting..." : "Submit proof"}
                </button>
                <button className="secondary-button" onClick={() => void saveDemoIdentity()} disabled={seeding || !derivedNpub}>
                  {seeding ? "Connecting..." : "Save identity"}
                </button>
                <button className="ghost-button" onClick={() => void checkSelectedVoter()} disabled={checkingVoter}>
                  {checkingVoter ? "Checking..." : "Check eligibility"}
                </button>
                <button className="ghost-button" onClick={() => void runDemoSequence()} disabled={runningDemo}>
                  {runningDemo ? "Running..." : "Run full demo"}
                </button>
              </div>
              <div className="demo-note">
                {voterCheck ? `${voterCheck.allowed ? "Eligible" : "Not eligible"}: ${voterCheck.message}` : "Run the eligibility check to show the voter path."}
              </div>
              {issuanceForSelected && (
                <div className="demo-note">
                  Issuance status: {issuanceForSelected.issued ? "issued" : "waiting"}.
                </div>
              )}
              <div className="demo-kv"><span>Active voter</span><code>{selectedVoter?.npub ? `${selectedVoter.npub.slice(0, 8)}...${selectedVoter.npub.slice(-4)}` : "Pending"}</code></div>
              <div className="demo-kv"><span>Vote choice</span><code>{voteChoice}</code></div>
              <div className="demo-kv"><span>Ballot content (kind 38000)</span><code>{ballotEventId ? ballotEventId.slice(0, 6) + "..." + ballotEventId.slice(-4) : "Waiting"}</code></div>
              <div className="demo-kv"><span>Submission status</span><code>{deliveredCoordinatorCount > 0 ? "ACCEPTED" : dmResults && dmResults.length > 0 ? "FAILED" : "Pending"}</code></div>
              <div className="demo-list">
                {eligibleNpubs.slice(0, 4).map((npub) => (
                  <div className="demo-list-item" key={npub}>
                    <code>{npub.slice(0, 18)}...</code>
                    <span>{issuanceStatus?.voters[npub]?.issued ? "issued" : "waiting"}</span>
                  </div>
                ))}
              </div>
            </div>
          </article>

          <article className="demo-card demo-console-card" id="demo-verifier">
            <PanelTitle
              kicker="Verifier"
              title="Tally and audit"
              right={auditResults.length > 0 ? <span className="demo-status demo-status-good">Ready</span> : confirmationResult ? <span className="demo-status demo-status-good">Confirmed</span> : <span className="demo-status">Pending</span>}
            />
            <div className="demo-stack">
              <div className="demo-console-field">
                <div className="demo-label">Commitment root</div>
                <code>{finalResult?.merkle_root ? `${finalResult.merkle_root.slice(0, 8)}...${finalResult.merkle_root.slice(-4)}` : "Unavailable"}</code>
              </div>
              <div className="demo-console-field">
                <div className="demo-label">Spent-tree</div>
                <code>{spentCommitmentRoot ? `${spentCommitmentRoot.slice(0, 8)}...${spentCommitmentRoot.slice(-4)}` : "Unavailable"}</code>
              </div>
              <div className="demo-console-field">
                <div className="demo-label">Yes / No tally</div>
                <div className="demo-console-progress">
                  <span>Yes {yesVotes}</span>
                  <span>No {noVotes}</span>
                </div>
                <div className="demo-note">The verifier recomputes the poll totals from public ballot events and receipts.</div>
              </div>
              <div className="demo-console-actions">
                <button className="primary-button" onClick={() => void publishDemoConfirmation()} disabled={confirmingVote || !ballotEventId || !isInConfirmationWindow}>
                  {confirmingVote ? "Publishing 38013..." : "Publish confirmation"}
                </button>
                <button className="secondary-button" onClick={() => void runVerifierAudit()} disabled={runningAudit || discoveredCoordinators.length === 0}>
                  {runningAudit ? "Running audit..." : "Run audit"}
                </button>
                <a className="ghost-button link-button" href="#demo-audit">Audit log</a>
              </div>
              {voteEnd > 0 && (
                <div className="demo-console-empty">
                  <div className="demo-note">{isInConfirmationWindow ? "Confirmation window is open." : "Waiting for the voting window to close."}</div>
                  {confirmEnd > 0 && <div className="demo-note">Confirmation window closes: {formatDateTime(confirmEnd)}</div>}
                </div>
              )}
              {confirmationResult && (
                <div className="demo-console-empty">
                  <div className="demo-note">Confirmation event `{confirmationResult.eventId.slice(0, 16)}...` published to {confirmationResult.successes} relay(s).</div>
                  {confirmationResult.failures > 0 && <div className="demo-note demo-note-warning">{confirmationResult.failures} failure(s).</div>}
                </div>
              )}
              <div className="demo-console-empty">
                <div className="demo-note">Inflation check</div>
                {auditResults.length > 0 ? (
                  <>
                    <div className={`demo-note ${acceptedVotes > confirmationCount ? "demo-note-warning" : ""}`}>{acceptedVotes > confirmationCount ? "Warning: tally exceeds confirmations." : "No inflation detected."}</div>
                    <div className={`demo-note ${acceptedVotes < confirmationCount ? "demo-note-warning" : ""}`}>{acceptedVotes < confirmationCount ? "Warning: confirmations exceed tally." : "No censorship detected."}</div>
                  </>
                ) : confirmationResult ? (
                  <div className="demo-note">Waiting for the verifier audit to count published confirmations.</div>
                ) : (
                  <div className="demo-note">Waiting for 38013 confirmations.</div>
                )}
              </div>
            </div>
          </article>
        </section>

        <section className="demo-audit-grid">
          <article className="demo-card demo-log-card" id="demo-audit">
            <PanelTitle kicker="Audit" title="Live protocol log" />
            <div className="demo-note">
              Auditors can reconstruct the spent commitment tree from those receipts.
            </div>
            <ol className="demo-timeline-list">
              {timelinePhases.map((phase) => (
                <li className={`demo-timeline-item is-${phase.status}`} key={phase.title}>
                  <span className="demo-timeline-rail">
                    <span className="demo-timeline-dot" />
                  </span>
                  <div className="demo-timeline-body">
                    <div className="demo-timeline-title-row">
                      <strong>{phase.title}</strong>
                      <span className={`status-pill status-pill-${phase.status === "done" ? "good" : phase.status === "current" ? "warn" : "neutral"}`}>
                        {phase.status === "done" ? "Done" : phase.status === "current" ? "Now" : "Waiting"}
                      </span>
                    </div>
                    <div className="demo-note">{phase.detail}</div>
                  </div>
                </li>
              ))}
            </ol>
          </article>
        </section>

        <section className="demo-security-section">
          <article className="demo-card demo-security-card" id="demo-security">
            <PanelTitle kicker="Security" title="Security guarantees" />
            <div className="demo-note">
              What the demo proves: these claims are backed by the live ballot, receipt, tally, and confirmation state shown above.
            </div>
            <div className="demo-security-grid">
              {securityGuarantees.map((item) => (
                <div className="demo-security-item" key={item.title}>
                  <div className="demo-security-head">
                    <strong className="demo-security-title">{item.title}</strong>
                    <span className={`status-pill status-pill-${item.status === "done" ? "good" : item.status === "current" ? "warn" : "neutral"}`}>
                      {item.status === "done" ? "Verified" : item.status === "current" ? "Visible" : "Waiting"}
                    </span>
                  </div>
                  <div className="demo-note">{item.detail}</div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="demo-audit-grid">
          <article className="demo-card">
            <PanelTitle kicker="Guide" title="What to copy where" />
            <div className="demo-list" id="demo-guide">
              <a className="demo-list-item demo-list-link" href="#demo-nsec">
                <span>Paste here</span>
                <code>{selectedVoter?.nsec ?? nsecInput}</code>
              </a>
              <a className="demo-list-item demo-list-link" href="#demo-voter-select">
                <span>Select voter</span>
                <code>switch view</code>
              </a>
              <a className="demo-list-item demo-list-link" href="#demo-poll">
                <span>Vote yes / no</span>
                <code>choose the side</code>
              </a>
              <a className="demo-list-item demo-list-link" href="#demo-voter">
                <span>Publish ballot</span>
                <code>this button</code>
              </a>
              <a className="demo-list-item demo-list-link" href="#demo-voter">
                <span>Submit proof</span>
                <code>this button</code>
              </a>
              <a className="demo-list-item demo-list-link" href="#demo-coordinator">
                <span>Mint proof</span>
                <code>on this page</code>
              </a>
              <a className="demo-list-item demo-list-link" href="#demo-voter">
                <span>Ballot and vote</span>
                <code>on this page</code>
              </a>
              <a className="demo-list-item demo-list-link" href="#demo-verifier">
                <span>Verify and audit</span>
                <code>on this page</code>
              </a>
            </div>
          </article>

          <article className="demo-card">
            <PanelTitle kicker="Refresh" title="Snapshot details" />
            <div className="demo-stack">
              <div className="demo-note">Last refresh: {lastRefresh ? new Date(lastRefresh).toLocaleString() : "Pending"}</div>
              <div className="demo-note">Issued passes: {issuedCount}</div>
              <div className="demo-note">Coordinator count: {coordinatorCount}</div>
              <div className="demo-note">Eligibility list size: {eligibleNpubs.length}</div>
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
