import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { deriveActorDisplayId } from "./actorDisplay";
import {
  latestHelplineMessageByPeer,
  mergeHelplineDmMessages,
  sendHelplineDmMessage,
  subscribeHelplineDmMessages,
  type HelplineDmMessage,
} from "./simpleHelplineDm";
import { UiButton, UiTextArea } from "./ui/DesignLayer";

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

const MESSAGE_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_URL_PUNCTUATION_PATTERN = /[\])}.,!?;:]+$/;

function splitTrailingUrlPunctuation(value: string) {
  const trailing = value.match(TRAILING_URL_PUNCTUATION_PATTERN)?.[0] ?? "";
  return {
    url: trailing ? value.slice(0, -trailing.length) : value,
    trailing,
  };
}

function hrefForMessageUrl(value: string) {
  return value.toLowerCase().startsWith("www.") ? `https://${value}` : value;
}

function renderMessageBody(value: string): ReactNode {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const match of value.matchAll(MESSAGE_URL_PATTERN)) {
    const rawMatch = match[0] ?? "";
    const matchIndex = match.index ?? 0;
    const { url, trailing } = splitTrailingUrlPunctuation(rawMatch);
    if (!url) {
      continue;
    }
    if (matchIndex > cursor) {
      nodes.push(value.slice(cursor, matchIndex));
    }
    nodes.push(
      <a
        key={`${matchIndex}:${url}`}
        className='simple-messages-link'
        href={hrefForMessageUrl(url)}
        target='_blank'
        rel='noopener noreferrer'
      >
        {url}
      </a>,
    );
    if (trailing) {
      nodes.push(trailing);
    }
    cursor = matchIndex + rawMatch.length;
  }

  if (nodes.length === 0) {
    return value;
  }
  if (cursor < value.length) {
    nodes.push(value.slice(cursor));
  }
  return nodes;
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
      hideReceivedQuestionnaireInviteLinks: props.role === "voter",
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
                  <UiButton
                    key={peerNpub}
                    icon='message'
                    className={`simple-messages-thread-button${selected ? " is-active" : ""}`}
                    onPress={() => setSelectedPeerNpub(peerNpub)}
                  >
                    <span className='simple-messages-thread-id'>{deriveActorDisplayId(peerNpub)}</span>
                    <span className='simple-messages-thread-preview'>
                      {latest ? previewText(latest.body) : "No messages yet"}
                    </span>
                    {latest ? (
                      <span className='simple-messages-thread-time'>{formatMessageTime(latest.createdAt)}</span>
                    ) : null}
                  </UiButton>
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
                    <p>{renderMessageBody(message.body)}</p>
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
              <UiTextArea
                textAreaClassName='simple-voter-textarea simple-messages-textarea'
                textAreaProps={{
                  value: draft,
                  rows: 4,
                  placeholder: props.role === "voter" ? "Type a message to the organiser..." : "Type a reply...",
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  },
                }}
              />
              <div className='simple-messages-composer-actions'>
                {status ? <p className='simple-voter-note'>{status}</p> : <span />}
                <UiButton
                  icon={sending ? "spinner" : "send"}
                  className='simple-voter-primary'
                  isDisabled={!canSend}
                  onPress={() => void sendMessage()}
                >
                  {sending ? "Sending..." : "Send"}
                </UiButton>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
