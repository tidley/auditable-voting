# Demo guide

Run through a voting loop.

Use this guide to:

1. Organise a questionnaire
2. Admit a voter
3. Submit a response and verify it

This demo takes about **5 minutes**.

By the end you will:

- &#10003; Publish a questionnaire as Organiser
- &#10003; Share the General invite link or QR code
- &#10003; Request a ballot from the real Voter flow
- &#10003; Submit a response
- &#10003; Check the live submission and final result in Observer

## The flow

```text
Open Organiser
      |
      v
Invite voters
      |
      v
Publish questionnaire
      |
      v
Share General invite
      |
      v
Submit response
      |
      v
Check Observer
      |
      v
Publish and verify results
```

## Run the demo

Use these pages:

- [Open Organiser](../web/public/simple-coordinator.html?role=coordinator)
- [Open Voter](../web/public/simple.html?role=voter)
- [Open Observer](../web/public/dashboard.html?role=auditor)

## Roles

| Role | What they do |
| --- | --- |
| Organiser | Creates the questions and settings, controls who can request a ballot, opens and closes the questionnaire, and publishes the result. |
| Voter | Opens an invite, receives a ballot credential, submits one response through a private identity, and keeps the Submission ID for checking. |
| Observer | Finds published questionnaires, checks accepted and invalid submissions, sees invalid reasons, and recomputes the final count from public data. |

## Step 1: Open Organiser and publish a questionnaire

Open **Organiser**.

If the same people will answer several questionnaires, open **Session** and use **Voters** to add their voter identities first. Use **Invite voters** in that section for the General invite link, Nostr invites, private invite links, and imported contacts. Add internal notes if useful, and leave **Auto-ballot** ticked for voters who should receive the next session. After the first questionnaire is published, use **Add session** under **Questionnaire** for follow-up questionnaires. It keeps the current setup, generates a fresh Questionnaire ID, shows one action, **Publish to invited voters**, and returns Organiser to **Session** after publishing. Voters still receive a fresh blind ballot credential for each questionnaire.

Fill in:

- **Name**
- **Description**
- At least one **Question prompt**

The **Readiness checklist** should show:

- **Title added**
- **Description added**
- **At least one question added**
- **Questions complete**

Click **Publish questionnaire**. When the draft is ready and Auto-ballot voters are selected, **Publish + apply invited voters** appears so the invited-voter roster can be green-lit immediately for this questionnaire.

When it appears, click **Open vote**.

## Step 2: Share the General invite

In **Organiser**, open **Invite voters**.

Use **General invite link**.

The General invite QR/link opens **Vote** and requests a ballot automatically.

You can:

- scan the QR code on a phone
- click **Copy link**
- click **Share...**

## Step 3: Open Voter and choose an identity

After scanning the QR or opening the invite, you should be on **Voter**.

Open **Menu**.

Use **Login** if you already have a voter identity, or use **New identity** for a fresh local demo identity.

The top-right label should show something like **Voter dv0lu66**.

> Nobody needs your email address, phone number or password.

## Step 4: Open the questionnaire invite

Open the organiser's questionnaire invite link or scan the General invite QR code.

The General invite should open the questionnaire and request a ballot automatically.

You should see:

- **Questionnaire** and its ID
- Title
- Description
- Questions

The submit button may say **Verifying vote request** while the organiser or audit proxy issues your ballot credential.

If ballot access gets stuck, open **Menu** then **Settings**. **Ballot details** shows the request, credential, submission, and timing fields needed for debugging.

## Step 5: Submit your response

Answer the questions.

For free-text questions, use **Encrypt for organiser** if the answer should not be public. If the organiser requires encryption, Vote keeps that option switched on.

When the button is ready, click **Submit response**.

If it is not ready, the button explains why. For example:

- **Please answer all required questions**
- **Verifying vote request**

After submission, Vote keeps the submitted answers visible and locks the questions so they cannot be changed on that page.

If several questionnaires are available, Vote shows a selector such as **1/3** with each round's status, and **Answer next** opens the next unanswered questionnaire.

After submission, the page shows **Private submission identity** with:

- **Questionnaire ID**
- **Submission ID**
- **Submittor identity - short**
- **Submittor identity - full**

This is the identity used for the public submission. It is not your normal voter identity.

## Step 6: Check the submitted vote in Observer

Open **Observer**.

Use **Questionnaire Results** to choose the questionnaire, then open **Submitted Votes**.

The Observer **Search** box can find a questionnaire by questionnaire ID, organiser identity, **Submission ID**, **Submittor identity - short**, or **Submittor identity - full**.

Match the voter page's **Submission ID** to Observer's **Response ID**.

You can also use the Submitted Votes filter with the **Submission ID**, **Submittor identity - short**, or **Submittor identity - full**.

Compare the private submission identity against the public **Submittor identity** row.

At this stage you can check:

- &#10003; The submission exists
- &#10003; Accepted submissions have no **Invalid** marker
- &#10003; Any invalid submission shows a reason
- &#10003; The public row matches the private submission identity shown to the voter

## Step 7: Publish and verify the questionnaire result

Observer can show live verified submissions before the final result is published.

For the final published result, return to **Organiser** and click **Close + publish results** or **Publish results**.

Open **Observer** again and click **Refresh**.

The Observer page shows:

- **Questionnaire Results**
- Accepted and invalid response counts
- Per-question result breakdowns
- **Submitted Votes**
- Audit details for accepted and rejected submissions

The result is calculated from published questionnaire submissions and decisions.

Anyone can independently verify the count from the public data.

At this stage you can check:

- &#10003; The reported result is correct
- &#10003; Counted submissions are genuine
- &#10003; Invalid submissions explain why they were rejected

## How is this different from a normal online questionnaire?

Traditional systems require voters to trust the operator and database.

With auditable voting:

| Question | Traditional online voting | Auditable voting |
| --- | --- | --- |
| Was my response recorded? | Trust required | You can check the public submission |
| Was my response altered? | Trust required | You can compare the published record |
| Was the result calculated correctly? | Trust required | Anyone can verify it |
| Can the organiser secretly change results? | Difficult to detect | Publicly detectable |

## Privacy

Your submitted response is linked to a private submission identity, not your normal voter identity or real-world identity.

The system is designed so that:

- Responses can be audited
- Results can be verified
- Personal information is not required
- Free-text answers can be encrypted for the organiser when configured that way

## What should I try next?

1. Open **Organiser**
2. Publish a questionnaire
3. Share the **General invite link**
4. Open **Voter** from the invite
5. Submit a response with **Submit response**
6. Check **Submitted Votes** in Observer
7. Publish and verify the final result
8. Compare your result with another participant

If two independent users obtain the same Observer result after refreshing from the same public data, they can be confident they are seeing the same questionnaire outcome.

## Plain-language explanation

Most people do not care about the phrase "auditable voting". They care about three questions:

- Can I check that my response was counted?
- Can anybody link the response back to me?
- Can somebody change the result?

This demo answers those questions directly:

- You can compare your private submission identity with the public submitted-vote row.
- Your submitted response uses a private submission identity, not your normal voter identity.
- The result is calculated from public records, so hidden changes are publicly detectable.

Technical details about signatures, relays, hashes, and Nostr belong in the separate **How it works** section.
