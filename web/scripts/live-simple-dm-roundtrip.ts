import * as nodeCrypto from "node:crypto";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
  SIMPLE_DM_RELAYS,
  fetchSimpleCoordinatorFollowers,
  fetchSimpleCoordinatorRosterAnnouncements,
  sendSimpleCoordinatorFollow,
  sendSimpleCoordinatorRoster,
} from "../src/simpleShardDm";
import { resetSharedNostrPoolForTests } from "../src/sharedNostrPool";

const webcrypto = nodeCrypto.webcrypto as unknown as Crypto;
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeIdentity() {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return {
    secretKey,
    npub: nip19.npubEncode(publicKey),
    nsec: nip19.nsecEncode(secretKey),
  };
}

async function waitForValue<T>(
  label: string,
  task: () => Promise<T>,
  isReady: (value: T) => boolean,
  timeoutMs = 45_000,
  intervalMs = 3_000,
) {
  const startedAt = Date.now();
  let lastValue: T | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await task();
    if (isReady(lastValue)) {
      return { value: lastValue, elapsedMs: Date.now() - startedAt };
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out; last=${JSON.stringify(lastValue)}`);
}

async function main() {
  const organiser = makeIdentity();
  const voters = Array.from({ length: 3 }, makeIdentity);
  const votingId = `dm_harness_${nodeCrypto.randomBytes(5).toString("hex")}`;

  process.stdout.write(JSON.stringify({
    phase: "dm_start",
    relays: SIMPLE_DM_RELAYS,
    voterCount: voters.length,
    votingId,
  }, null, 2) + "\n");

  const voterToOrganiser = [];
  for (let index = 0; index < voters.length; index += 1) {
    const voter = voters[index];
    const sent = await sendSimpleCoordinatorFollow({
      voterSecretKey: voter.secretKey,
      coordinatorNpub: organiser.npub,
      voterNpub: voter.npub,
      votingId,
      relays: SIMPLE_DM_RELAYS,
    });
    voterToOrganiser.push({
      voter: index + 1,
      eventId: sent.eventId,
      successes: sent.successes,
      failures: sent.failures,
      relayResults: sent.relayResults,
    });
  }

  const followerRead = await waitForValue(
    "organiser follower readback",
    () => fetchSimpleCoordinatorFollowers({
      coordinatorNsec: organiser.nsec,
      relays: SIMPLE_DM_RELAYS,
    }),
    (followers) => voters.every((voter) => (
      followers.some((follower) => (
        follower.voterNpub === voter.npub && follower.votingId === votingId
      ))
    )),
  );

  const organiserToVoter = [];
  for (let index = 0; index < voters.length; index += 1) {
    const voter = voters[index];
    const sent = await sendSimpleCoordinatorRoster({
      leadCoordinatorSecretKey: organiser.secretKey,
      recipientNpub: voter.npub,
      leadCoordinatorNpub: organiser.npub,
      coordinatorNpubs: [organiser.npub],
      questionnaireId: votingId,
      questionnaireState: "dm_harness",
      relays: SIMPLE_DM_RELAYS,
    });
    organiserToVoter.push({
      voter: index + 1,
      eventId: sent.eventId,
      successes: sent.successes,
      failures: sent.failures,
      relayResults: sent.relayResults,
    });
  }

  const rosterReads = [];
  for (let index = 0; index < voters.length; index += 1) {
    const voter = voters[index];
    const read = await waitForValue(
      `voter ${index + 1} roster readback`,
      () => fetchSimpleCoordinatorRosterAnnouncements({
        voterNsec: voter.nsec,
        relays: SIMPLE_DM_RELAYS,
      }),
      (announcements) => announcements.some((announcement) => (
        announcement.leadCoordinatorNpub === organiser.npub
        && announcement.questionnaireId === votingId
      )),
    );
    rosterReads.push({
      voter: index + 1,
      announcements: read.value.length,
      elapsedMs: read.elapsedMs,
    });
  }

  process.stdout.write(JSON.stringify({
    phase: "dm_complete",
    passed: true,
    relays: SIMPLE_DM_RELAYS,
    voterToOrganiser,
    organiserFollowerReadback: {
      followers: followerRead.value.length,
      elapsedMs: followerRead.elapsedMs,
    },
    organiserToVoter,
    voterRosterReadback: rosterReads,
  }, null, 2) + "\n");
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    resetSharedNostrPoolForTests();
  });
