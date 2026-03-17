import { useState } from "react";
import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from "nostr-tools";

export default function App() {
  const [choice, setChoice] = useState("");
  const [eventId, setEventId] = useState("");

  async function submitVote() {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);

    const event = finalizeEvent(
      {
        kind: 38000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["election", "election1"]],
        content: JSON.stringify({ vote_choice: choice }),
        pubkey: pk
      },
      sk
    );

    const pool = new SimplePool();
    await pool.publish(["wss://relay.damus.io"], event);

    setEventId(event.id);
  }

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif" }}>
      <h1>Auditable Voting</h1>
      <input
        placeholder="Your vote"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      />
      <button onClick={submitVote}>Submit Vote</button>
      {eventId && (
        <div>
          <p>Event ID:</p>
          <code>{eventId}</code>
        </div>
      )}
    </div>
  );
}
