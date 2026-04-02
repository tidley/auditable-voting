import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import {
  SIMPLE_BLIND_KEY_KIND,
  SIMPLE_BLIND_SCHEME,
  createSimpleBlindIssuanceRequest,
  createSimpleBlindShareResponse,
  deriveTokenIdFromSimpleShardCertificates,
  generateSimpleBlindKeyPair,
  parseSimpleBlindKeyAnnouncement,
  parseSimpleShardCertificate,
  toSimpleBlindPublicKey,
  unblindSimpleBlindShare,
} from "../src/simpleShardCertificate";

const webcrypto = nodeCrypto.webcrypto;

function makeSecretKey(seed: number) {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 255 || 1);
}

function makeAnnouncementEvent(privateKey: Awaited<ReturnType<typeof generateSimpleBlindKeyPair>>, coordinatorSecretKey: Uint8Array) {
  return finalizeEvent({
    kind: SIMPLE_BLIND_KEY_KIND,
    created_at: 1_750_000_000,
    tags: [
      ["t", "simple-blind-key"],
      ["key-id", privateKey.keyId],
    ],
    content: JSON.stringify({
      scheme: SIMPLE_BLIND_SCHEME,
      key_id: privateKey.keyId,
      bits: privateKey.bits,
      n: privateKey.n,
      e: privateKey.e,
      created_at: "2026-04-02T00:00:00.000Z",
    }),
  }, coordinatorSecretKey);
}

async function main() {
  const coordinatorOneSecret = makeSecretKey(11);
  const coordinatorTwoSecret = makeSecretKey(77);
  const coordinatorOneNpub = nip19.npubEncode(getPublicKey(coordinatorOneSecret));
  const coordinatorTwoNpub = nip19.npubEncode(getPublicKey(coordinatorTwoSecret));

  const keyOne = await generateSimpleBlindKeyPair(1024, webcrypto);
  const keyTwo = await generateSimpleBlindKeyPair(1024, webcrypto);

  const announcementOne = makeAnnouncementEvent(keyOne, coordinatorOneSecret);
  const parsedAnnouncement = parseSimpleBlindKeyAnnouncement(announcementOne, coordinatorOneNpub);
  assert(parsedAnnouncement, "expected blind key announcement to parse");
  assert.equal(parsedAnnouncement.publicKey.keyId, keyOne.keyId);

  const requestOne = await createSimpleBlindIssuanceRequest({
    publicKey: toSimpleBlindPublicKey(keyOne),
    votingId: "vote-1",
    tokenMessage: "vote-1:shared-token",
    webCrypto: webcrypto,
  });
  const requestTwo = await createSimpleBlindIssuanceRequest({
    publicKey: toSimpleBlindPublicKey(keyTwo),
    votingId: "vote-1",
    tokenMessage: "vote-1:shared-token",
    webCrypto: webcrypto,
  });

  const responseOne = createSimpleBlindShareResponse({
    privateKey: keyOne,
    keyAnnouncementEvent: announcementOne,
    coordinatorNpub: coordinatorOneNpub,
    request: requestOne.request,
    shareIndex: 1,
    thresholdT: 2,
    thresholdN: 2,
    webCrypto: webcrypto,
  });
  const responseTwo = createSimpleBlindShareResponse({
    privateKey: keyTwo,
    keyAnnouncementEvent: makeAnnouncementEvent(keyTwo, coordinatorTwoSecret),
    coordinatorNpub: coordinatorTwoNpub,
    request: requestTwo.request,
    shareIndex: 2,
    thresholdT: 2,
    thresholdN: 2,
    webCrypto: webcrypto,
  });

  const shareOne = unblindSimpleBlindShare({
    response: responseOne,
    secret: requestOne.secret,
  });
  const shareTwo = unblindSimpleBlindShare({
    response: responseTwo,
    secret: requestTwo.secret,
  });

  const parsedShare = parseSimpleShardCertificate(shareOne, coordinatorOneNpub);
  assert(parsedShare, "expected blind share to validate");
  assert.equal(parsedShare.votingId, "vote-1");
  assert.equal(parsedShare.thresholdT, 2);
  assert.equal(parsedShare.thresholdN, 2);

  const stableTokenId = await deriveTokenIdFromSimpleShardCertificates([shareOne, shareTwo]);
  assert.match(stableTokenId ?? "", /^[0-9a-f]{20}$/);

  const wrongRequest = await createSimpleBlindIssuanceRequest({
    publicKey: toSimpleBlindPublicKey(keyTwo),
    votingId: "vote-1",
    webCrypto: webcrypto,
  });
  const wrongResponse = createSimpleBlindShareResponse({
    privateKey: keyOne,
    keyAnnouncementEvent: announcementOne,
    coordinatorNpub: coordinatorOneNpub,
    request: wrongRequest.request,
    shareIndex: 1,
    webCrypto: webcrypto,
  });

  assert.throws(() => unblindSimpleBlindShare({
    response: wrongResponse,
    secret: wrongRequest.secret,
  }), /wrong public key/i);

  const mismatchedRequest = await createSimpleBlindIssuanceRequest({
    publicKey: toSimpleBlindPublicKey(keyTwo),
    votingId: "vote-1",
    tokenMessage: "vote-1:different-token",
    webCrypto: webcrypto,
  });
  const mismatchedShare = unblindSimpleBlindShare({
    response: createSimpleBlindShareResponse({
      privateKey: keyTwo,
      keyAnnouncementEvent: makeAnnouncementEvent(keyTwo, coordinatorTwoSecret),
      coordinatorNpub: coordinatorTwoNpub,
      request: mismatchedRequest.request,
      shareIndex: 2,
    webCrypto: webcrypto,
    }),
    secret: mismatchedRequest.secret,
  });

  const mismatchedTokenId = await deriveTokenIdFromSimpleShardCertificates([shareOne, mismatchedShare]);
  assert.equal(mismatchedTokenId, null);

  process.stdout.write("simple blind share verification passed\n");
}

void main();
