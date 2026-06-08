# Plain-English demo guide

Use this when introducing Auditable Voting to people who do not care about the technical protocol.

## One-minute explanation

Auditable Voting is a way to run a questionnaire where:

- the organiser can decide who is allowed to vote;
- voters can submit without their answer being tied back to their normal identity;
- anyone can check the published count afterwards.

The easiest analogy is a paper voting room:

1. Someone checks that you are on the list.
2. You receive a ballot paper.
3. You walk away and fill it in privately.
4. The ballot goes into a public count.
5. Observers can check the count without knowing which paper was yours.

Auditable Voting brings that pattern to a browser, using public relay data instead of a private database.

## The three roles

### Organiser

They create the questionnaire, share invite links or QR codes, approve voters when needed, and publish the final result.

### Voter

The voter opens an invite, requests a ballot, answers the questions, and submits.

The voter may see a short wait while the organiser verifies the ballot request. That is the digital version of checking someone is allowed to take part.

### Watcher

In the app this is the **Observer**.

They can open the public result view and check that the published count matches the public accepted responses.

## Meeting demo plan

This is a simple 10 minute walkthrough.

1. Open the Organiser page.
2. Create a short questionnaire with one or two questions.
3. Show the General invite QR code.
4. Scan or open the invite as a Voter.
5. Submit one response.
6. Return to Organiser and show the accepted response count.
7. Close and publish results.
8. Open Observer and show that the public result can be checked separately.

Keep the language simple:

- Say **watcher** or **public checker** instead of observer.
- Say **private ballot pass** instead of blind credential unless someone asks for the technical detail.
- Say **public noticeboard** instead of Nostr relays.

## What to show on screen

### Start with Organiser

Show that the organiser can:

- name the questionnaire;
- add questions;
- publish it;
- share the General invite link or QR code;
- see when responses arrive;
- publish the final result.

### Then show Voter

Show that the voter can:

- open the link from a phone or browser;
- request a ballot automatically from the QR link;
- wait while the request is verified;
- answer the questionnaire;
- submit once.

Do not start by explaining cryptography. Let the screen show the everyday workflow first.

### Finish with Observer

Show that a separate person can:

- find the questionnaire;
- see accepted and rejected responses;
- see why any response was rejected;
- check the result without needing access to the organiser's private browser state.

## What is private and what is public

Private:

- the voter's normal identity;
- the organiser's secret key;
- the link between a specific voter and their final answer;
- encrypted answer details unless the right key is deliberately supplied.

Public:

- the questionnaire;
- anonymous submitted responses;
- accept or reject decisions;
- the final result summary.

## Useful phrases

**Why not just use a normal survey tool?**

Normal survey tools usually require trusting the operator and the database. This project is about making the count independently checkable.

**Can the organiser see who voted for what?**

The organiser can decide who may take part. The submitted response uses a separate response identity, so the normal voter identity is not the public ballot identity.

**Can someone vote twice?**

Each ballot credential can only be accepted once. Duplicate or invalid submissions are rejected and the reason is shown.

**What if the network is slow?**

The app uses public relays, so delivery can sometimes take a few seconds. The screens refresh and retry, but this is still experimental software.

**Is this ready for official elections?**

No. Treat it as experimental infrastructure that demonstrates a verifiable pattern. It needs independent review before high-stakes use.

## Safe caveats

Use these when setting expectations:

- This is a working prototype, not a production election service.
- Public relay reliability can affect timing.
- Private keys stay in the browser, so device handling matters.
- The cryptographic and protocol design should be independently reviewed before serious deployment.

## Short closing line

The important idea is simple: eligibility is checked before voting, the vote is submitted privately, and the public can still check the count.
