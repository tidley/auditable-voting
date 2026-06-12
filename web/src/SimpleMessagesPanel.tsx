import { useEffect, useMemo, useRef, useState } from "react";
import { deriveActorDisplayId } from "./actorDisplay";
import {
  latestHelplineMessageByPeer,
  mergeHelplineDmMessages,
  sendHelplineDmMessage,
  subscribeHelplineDmMessages,
  type HelplineDmMessage,
} from "./simpleHelplineDm";

type SimpleMessagesPanelProps = {
  actorNpub: string;
  actorNsec: string;
  role: "voter" | "coordinator";
  targetNpubs?: string[];
};

function formatMessageTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function previewText(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export default function SimpleMessagesPanel(props: SimpleMessagesPanelProps) {
  const [messages, setMessages] = useState<HelplineDmMessage[]>([]);
  const [selectedPeerNpub, setSelectedPeerNpub] = useState("");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const actorNpub = props.actorNpub.trim();
  const actorNsec = props.actorNsec.trim();
  const targetNpubs = useMemo(() => uniqueNonEmpty(props.targetNpubs ?? []), [props.targetNpubs]);
  const voterTargetRequired = props.role === "voter";

  useEffect(() => {
    if (!actorNsec || (voterTargetRequired && targetNpubs.length === 0)) {
      setMessages([]);
      setStatus(null);
      return undefined;
    }
    setStatus("Loading messages...");
    const unsubscribe = subscribeHelplineDmMessages({
      actorNsec,
      allowedPeerNpubs: voterTargetRequired ? targetNpubs : undefined,
      onMessages: (nextMessages) => {
        setMessages(nextMessages);
        setStatus((current) => (current === "Loading messages..." ? null : current));
      },
      onError: () => {
        setStatus("Could not load messages.");
      },
    });
    return unsubscribe;
  }, [actorNsec, targetNpubs, voterTargetRequired]);

  const latestByPeer = useMemo(() => latestHelplineMessageByPeer(messages), [messages]);
  const peerNpubs = useMemo(() => {
    if (props.role === "voter") {
      return targetNpubs;
    }
    const fromMessages = messages
      .map((message) => message.peerNpub)
      .filter((peerNpub) => peerNpub !== actorNpub);
    return uniqueNonEmpty([...targetNpubs, ...fromMessages]);
  }, [actorNpub, messages, props.role, targetNpubs]);

  useEffect(() => {
    if (peerNpubs.length === 0) {
      if (selectedPeerNpub) {
        setSelectedPeerNpub("");
      }
      return;
    }
    if (!selectedPeerNpub || !peerNpubs.includes(selectedPeerNpub)) {
      setSelectedPeerNpub(peerNpubs[0]);
    }
  }, [peerNpubs, selectedPeerNpub]);

  const threadMessages = useMemo(
    () => messages.filter((message) => message.peerNpub === selectedPeerNpub),
    [messages, selectedPeerNpub],
  );

  useEffect(() => {
    const threadEnd = threadEndRef.current;
    if (typeof threadEnd?.scrollIntoView === "function") {
      threadEnd.scrollIntoView({ block: "end" });
    }
  }, [threadMessages.length, selectedPeerNpub]);

  const canSend = Boolean(actorNsec && selectedPeerNpub && draft.trim() && !sending);
  const showThreadList = !(props.role === "voter" && peerNpubs.length === 1);
  const lockedText = props.role === "voter"
    ? "Use the local voter identity to send and read helpline messages. Signer-only voter sessions cannot unwrap NIP-17 messages here yet."
    : "Use the local organiser identity to send and read helpline messages. Signer-only organiser sessions cannot unwrap NIP-17 messages here yet.";

  async function sendMessage() {
    if (!canSend) {
      return;
    }
    const body = draft.trim();
    setSending(true);
    setStatus("Sending message...");
    try {
      const result = await sendHelplineDmMessage({
        senderNsec: actorNsec,
        recipientNpub: selectedPeerNpub,
        message: body,
      });
      setMessages((current) => mergeHelplineDmMessages([...current, result.message]));
      setDraft("");
      setStatus(
        result.successes > 0
          ? `Message sent (${result.successes}/${result.relayResults.length} relay writes).`
          : "Message was signed but no relay accepted it.",
      );
    } catch {
      setStatus("Could not send message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className='simple-messages-panel' aria-label='Messages'>
      {!actorNsec ? (
        <div className='simple-messages-empty-state'>
          <p className='simple-voter-empty'>{lockedText}</p>
        </div>
      ) : peerNpubs.length === 0 ? (
        <div className='simple-messages-empty-state'>
          <p className='simple-voter-empty'>
            {props.role === "voter"
              ? "Add or open an organiser before sending a message."
              : "No voter messages have arrived yet."}
          </p>
        </div>
      ) : (
        <div className={`simple-messages-grid${showThreadList ? "" : " is-single-thread"}`}>
          {showThreadList ? (
            <aside className='simple-messages-thread-list' aria-label='Conversations'>
              {peerNpubs.map((peerNpub) => {
                const latest = latestByPeer.get(peerNpub);
                const selected = selectedPeerNpub === peerNpub;
                return (
                  <button
                    key={peerNpub}
                    type='button'
                    className={`simple-messages-thread-button${selected ? " is-active" : ""}`}
                    onClick={() => setSelectedPeerNpub(peerNpub)}
                  >
                    <span className='simple-messages-thread-id'>{deriveActorDisplayId(peerNpub)}</span>
                    <span className='simple-messages-thread-preview'>
                      {latest ? previewText(latest.body) : "No messages yet"}
                    </span>
                    {latest ? (
                      <span className='simple-messages-thread-time'>{formatMessageTime(latest.createdAt)}</span>
                    ) : null}
                  </button>
                );
              })}
            </aside>
          ) : null}

          <section className='simple-messages-chat' aria-label='Message thread'>
            <div className='simple-messages-chat-title'>
              <div>
                <p className='simple-account-menu-kicker'>
                  {props.role === "voter" ? "Organiser" : "Voter"}
                </p>
                <h4 className='simple-voter-section-title'>
                  {selectedPeerNpub ? deriveActorDisplayId(selectedPeerNpub) : "Select a thread"}
                </h4>
              </div>
            </div>
            <div className='simple-messages-bubbles' aria-live='polite'>
              {threadMessages.length > 0 ? (
                threadMessages.map((message) => (
                  <article
                    key={`${message.id}:${message.dmEventId}`}
                    className={`simple-messages-bubble ${message.direction === "sent" ? "is-sent" : "is-received"}`}
                  >
                    <p>{message.body}</p>
                    <span>{formatMessageTime(message.createdAt)}</span>
                  </article>
                ))
              ) : (
                <p className='simple-voter-empty simple-messages-empty-thread'>
                  No messages in this thread yet.
                </p>
              )}
              <div ref={threadEndRef} />
            </div>
            <div className='simple-messages-composer'>
              <textarea
                className='simple-voter-textarea simple-messages-textarea'
                value={draft}
                rows={4}
                placeholder={props.role === "voter" ? "Type a message to the organiser..." : "Type a reply..."}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <div className='simple-messages-composer-actions'>
                {status ? <p className='simple-voter-note'>{status}</p> : <span />}
                <button
                  type='button'
                  className='simple-voter-primary'
                  disabled={!canSend}
                  onClick={() => void sendMessage()}
                >
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
