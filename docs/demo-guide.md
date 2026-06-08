# Auditable Voting Demo

This demo takes about **3 minutes**.

By the end you will:

- &#10003; Open the real Voter flow
- &#10003; Request a ballot from a questionnaire invite
- &#10003; Submit a response
- &#10003; Check the submission in Observer
- &#10003; Learn how anyone can audit the questionnaire result

## The flow

```text
Open Voter
      |
      v
Login or New identity
      |
      v
Open + request ballot
      |
      v
Submit response
      |
      v
Check Observer
```

## Step 1: Open Voter and choose an identity

Open **Voter**.

Open **Menu**.

Use **Login** if you already have a voter identity, or use **New identity** for a fresh local demo identity.

The top-right label should show something like **Voter dv0lu66**.

> Nobody needs your email address, phone number or password.

## Step 2: Open the questionnaire invite

Open the organiser's questionnaire invite link or scan the General invite QR code.

If the page shows **Pending invites**, click **Open + request ballot**.

You should see:

- **Questionnaire** and its ID
- Title
- Description
- Questions

The submit button may say **Verifying vote request** while the organiser or audit proxy issues your ballot credential.

## Step 3: Submit your response

Answer the questions.

For free-text questions, use **Encrypt for organiser** if the answer should not be public.

When the button is ready, click **Submit response**.

If it is not ready, the button explains why. For example:

- **Please answer all required questions**
- **Verifying vote request**

After submission, the page shows **Private submission identity** with:

- **Submission ID**
- **Submittor identity - short**
- **Submittor identity - full**

This is the identity used for the public submission. It is not your normal voter identity.

## Step 4: Check the submitted vote

Open **Observer**.

Use **Find Published Questionnaires** to choose the questionnaire, then open **Submitted Votes**.

Use the voter page's **Submission ID** and private submission identity to compare against the public submitted-vote row.

At this stage you can check:

- &#10003; The submission exists
- &#10003; It has an accepted or invalid status
- &#10003; Any invalid submission shows a reason
- &#10003; The public row matches the private submission identity shown to the voter

## Step 5: Check the questionnaire result

After the organiser clicks **Close + publish results** or **Publish results**, open **Observer** again and click **Refresh**.

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

1. Open **Voter**
2. Use **Login** or **New identity**
3. Open a questionnaire invite with **Open + request ballot**
4. Submit a response with **Submit response**
5. Check **Submitted Votes** in Observer
6. Compare your result with another participant

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
