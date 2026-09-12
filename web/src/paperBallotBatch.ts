import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { generatePaperBallot, type PaperBallot } from "./paperBallot";
import type { SupportedLocale } from "./i18n";

/**
 * Upper bound for a single batch.  Generation is synchronous and every ballot
 * carries a fresh keypair, so an accidental huge number in the coordinator UI
 * would otherwise freeze the browser tab.
 */
export const MAX_PAPER_BALLOT_BATCH = 500;

export interface VoterKeypair {
  nsec: string;
  npub: string;
}

export interface PaperBallotBatchResult {
  ballots: PaperBallot[];
  /**
   * The keypairs behind `ballots`, aligned by index.  The coordinator needs the
   * raw nsec to reprint a lost ballot; the npub is what gets admitted.
   */
  keypairs: VoterKeypair[];
  /**
   * Optional per-ballot label (for example the admitted voter a ballot is
   * handed to), aligned with `ballots`.
   */
  labels: (string | undefined)[];
  /** One entry per voter whose ballot could not be generated. */
  errors: string[];
  /** Locale the batch was printed in. */
  locale: SupportedLocale;
}

/**
 * Generate a fresh Nostr keypair (nsec + npub) for a paper ballot voter.
 * Uses nostr-tools generateSecretKey() and nip19 encoding.
 */
export function generateVoterKeypair(): VoterKeypair {
  const secretKey = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

/**
 * Generate paper ballots in batch for N voters.
 *
 * For each voter:
 *   1. Generate a fresh nsec via generateSecretKey() + nip19.nsecEncode()
 *   2. Derive the corresponding npub
 *   3. Create a PaperBallot using generatePaperBallot()
 *
 * A single failing voter does not abandon the batch: the failure is recorded in
 * `errors` (prefixed with the 1-based voter number) and generation continues, so
 * a coordinator who asked for 40 ballots does not lose the 39 that worked.
 *
 * @param definition   The questionnaire definition to build ballots from
 * @param voterCount   Number of ballots to generate (1..MAX_PAPER_BALLOT_BATCH)
 * @param inviteCodes  Optional invite codes, one per voter (length must match voterCount)
 * @param voterLabels  Optional labels, one per voter (length must match voterCount)
 * @param locale       Locale the ballots are printed in (defaults to English)
 * @returns Batch result with ballots, keypairs, labels and any errors
 */
export function generatePaperBallotBatch(input: {
  definition: QuestionnaireDefinition;
  voterCount: number;
  inviteCodes?: string[];
  voterLabels?: string[];
  locale?: SupportedLocale;
}): PaperBallotBatchResult {
  const { definition, voterCount, inviteCodes, voterLabels, locale = "en" } = input;

  if (!Number.isInteger(voterCount) || voterCount <= 0) {
    throw new Error(`voterCount must be a positive integer, got ${voterCount}`);
  }

  if (voterCount > MAX_PAPER_BALLOT_BATCH) {
    throw new Error(
      `voterCount must not exceed ${MAX_PAPER_BALLOT_BATCH}, got ${voterCount}`,
    );
  }

  if (inviteCodes !== undefined && inviteCodes.length !== voterCount) {
    throw new Error(
      `inviteCodes length (${inviteCodes.length}) must match voterCount (${voterCount})`,
    );
  }

  if (voterLabels !== undefined && voterLabels.length !== voterCount) {
    throw new Error(
      `voterLabels length (${voterLabels.length}) must match voterCount (${voterCount})`,
    );
  }

  const ballots: PaperBallot[] = [];
  const keypairs: VoterKeypair[] = [];
  const labels: (string | undefined)[] = [];
  const errors: string[] = [];

  for (let i = 0; i < voterCount; i++) {
    try {
      const keypair = generateVoterKeypair();
      const ballot = generatePaperBallot({
        definition,
        voterNsec: keypair.nsec,
        inviteCode: inviteCodes?.[i],
        locale,
      });

      keypairs.push(keypair);
      ballots.push(ballot);
      labels.push(voterLabels?.[i]);
    } catch (err) {
      errors.push(`Voter ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ballots, keypairs, labels, errors, locale };
}
