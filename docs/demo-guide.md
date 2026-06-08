# Auditable Voting Demo

This demo takes about **3 minutes**.

By the end you will:

- &#10003; Cast a vote
- &#10003; Verify that your vote was recorded
- &#10003; Verify that it was included in the final result
- &#10003; Learn how anyone can audit the election

## The flow

```text
Create account
      |
      v
Join election
      |
      v
Vote
      |
      v
Verify vote
      |
      v
Verify result
```

## Step 1: Create an account

Click **Create Account**.

The system generates a unique cryptographic identity for you.

Your identity allows you to vote without revealing your real name.

> Nobody needs your email address, phone number or password.

## Step 2: Join the election

Open the election invitation.

You will see:

- Election title
- Description
- Voting options
- Opening and closing dates

Click **Join Election**.

## Step 3: Cast your vote

Select your preferred option.

Click **Submit Vote**.

The system creates a signed voting record.

You should now see a confirmation message.

&#10003; Your vote has been recorded.

## Step 4: Verify your vote

Open **My Vote**.

You will see a unique Vote ID.

Use this to confirm that:

- Your vote exists
- It has not been modified
- It appears in the election record

At this stage you can verify:

- &#10003; Your vote was received
- &#10003; Your vote has not been changed

## Step 5: Verify the election result

Once voting closes, open **Election Results**.

You can see:

- Total votes
- Vote breakdown
- Audit information

The result is calculated from the published votes.

Anyone can independently verify the count.

At this stage you can verify:

- &#10003; The reported result is correct
- &#10003; All counted votes are genuine
- &#10003; No votes were added or removed

## How is this different from normal online voting?

Traditional systems require voters to trust the operator.

With auditable voting:

| Question | Traditional voting | Auditable voting |
| --- | --- | --- |
| Was my vote recorded? | Trust required | You can verify it |
| Was my vote altered? | Trust required | You can verify it |
| Was the result calculated correctly? | Trust required | Anyone can verify it |
| Can the organiser secretly change results? | Difficult to detect | Publicly detectable |

## Privacy

Your vote is linked to your cryptographic identity, not your real-world identity.

The system is designed so that:

- Votes can be audited
- Results can be verified
- Personal information is not required

## What should I try next?

1. Create an account
2. Cast a vote
3. Verify your vote
4. Compare your verification result with another participant
5. Explore the audit data

If two independent users obtain the same verification result, they can be confident they are seeing the same election outcome.

## Plain-language explanation

Most people do not care about the phrase "auditable voting". They care about three questions:

- Can I verify my vote was counted?
- Can anybody see who I voted for?
- Can somebody change the result?

This demo answers those questions directly:

- You can independently check that your vote was included in the final count.
- Your vote is connected to a cryptographic identity, not your real name.
- The result is calculated from public records, so hidden changes are publicly detectable.

Technical details about signatures, relays, hashes, and Nostr belong in the separate **How it works** section.
