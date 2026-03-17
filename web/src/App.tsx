import { useState } from "react";
import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from "nostr-tools";

export default function App() {
  const [choice, setChoice] = useState("");
  const [cashuNote, setCashuNote] = useState("");
  const [eventId, setEventId] = useState("");
  const [npub, setNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  async function submitVote() {
    setStatus(null);

    if (!cashuNote) {
      setStatus("❌ Vote rejected: missing Cashu proof");
      return;
    }

    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    setNpub(pk);

    const event = finalizeEvent(
      {
        kind: 38000,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["election", "election1"]],
        content: JSON.stringify({
          vote_choice: choice
        }),
        pubkey: pk
      },
      sk
    );

    const pool = new SimplePool();
    await pool.publish(["wss://relay.damus.io"], event);

    setEventId(event.id);

    // TODO: Replace with real mint API call
    // For now we simulate acceptance/rejection logic
    if (cashuNote.startsWith("spent")) {
      setStatus("❌ Vote rejected: proof already spent");
    } else {
      setStatus("✅ Vote accepted (proof marked as spent)");
    }
  }

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif" }}>
      <h1>Auditable Voting</h1>
      <input
        placeholder="Your vote"
        value={choice}
        onChange={(e) => setChoice(e.target.value)}
      />
      <br /><br />
      <input
        placeholder="Cashu proof (note)"
        value={cashuNote}
        onChange={(e) => setCashuNote(e.target.value)}
        style={{ width: 400 }}
      />
      <br /><br />
      <button onClick={submitVote}>Submit Vote</button>
      {eventId && (
        <div>
          <p>Event ID:</p>
          <code>{eventId}</code>
        </div>
      )}
      {npub && (
        <div>
          <p>Npub used for this vote:</p>
          <code>{npub}</code>
        </div>
      )}
      {status && (
        <div>
          <p>Status:</p>
          <strong>{status}</strong>
        </div>
      )}
    </div>
  );
}
