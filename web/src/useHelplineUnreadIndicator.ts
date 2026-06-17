import { useEffect, useMemo, useRef, useState } from "react";
import {
  subscribeHelplineDmMessages,
  type HelplineDmMessage,
} from "./simpleHelplineDm";

function uniqueNonEmpty(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function messageKey(message: HelplineDmMessage) {
  return message.id.trim() || message.dmEventId.trim();
}

export function useHelplineUnreadIndicator(input: {
  actorNsec: string;
  allowedPeerNpubs?: string[];
  requireAllowedPeer?: boolean;
  suppressUnread?: boolean;
  hideReceivedQuestionnaireInviteLinks?: boolean;
}) {
  const [hasUnread, setHasUnread] = useState(false);
  const suppressUnreadRef = useRef(Boolean(input.suppressUnread));
  const seenReceivedIdsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const actorNsec = input.actorNsec.trim();
  const allowedPeerNpubs = useMemo(
    () => uniqueNonEmpty(input.allowedPeerNpubs ?? []),
    [input.allowedPeerNpubs],
  );
  const allowedPeerNpubKey = allowedPeerNpubs.join("|");

  useEffect(() => {
    suppressUnreadRef.current = Boolean(input.suppressUnread);
    if (input.suppressUnread) {
      setHasUnread(false);
    }
  }, [input.suppressUnread]);

  useEffect(() => {
    seenReceivedIdsRef.current = new Set();
    primedRef.current = false;
    setHasUnread(false);

    if (!actorNsec || (input.requireAllowedPeer && allowedPeerNpubs.length === 0)) {
      return undefined;
    }

    return subscribeHelplineDmMessages({
      actorNsec,
      allowedPeerNpubs: allowedPeerNpubs.length > 0 ? allowedPeerNpubs : undefined,
      hideReceivedQuestionnaireInviteLinks: input.hideReceivedQuestionnaireInviteLinks,
      onMessages: (messages) => {
        const receivedIds = messages
          .filter((message) => message.direction === "received")
          .map(messageKey)
          .filter((id) => id.length > 0);
        const seen = seenReceivedIdsRef.current;

        if (!primedRef.current) {
          seenReceivedIdsRef.current = new Set(receivedIds);
          primedRef.current = true;
          return;
        }

        const hasNewReceived = receivedIds.some((id) => !seen.has(id));
        seenReceivedIdsRef.current = new Set([...seen, ...receivedIds]);
        if (hasNewReceived && !suppressUnreadRef.current) {
          setHasUnread(true);
        }
      },
      onError: () => undefined,
    });
  }, [actorNsec, allowedPeerNpubKey, allowedPeerNpubs, input.hideReceivedQuestionnaireInviteLinks, input.requireAllowedPeer]);

  return hasUnread;
}
