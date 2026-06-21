import { useCallback, useEffect, useRef, useState } from "react";

const DEFAULT_COPIED_LABEL_MS = 1500;

export function useTransientCopiedLabel(durationMs = DEFAULT_COPIED_LABEL_MS) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const showCopied = useCallback((key: string) => {
    clearTimer();
    setCopiedKey(key);
    timerRef.current = setTimeout(() => {
      setCopiedKey(null);
      timerRef.current = null;
    }, durationMs);
  }, [clearTimer, durationMs]);

  const isCopied = useCallback((key: string) => copiedKey === key, [copiedKey]);

  useEffect(() => clearTimer, [clearTimer]);

  return { copiedKey, isCopied, showCopied };
}
