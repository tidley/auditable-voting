import { notifyPressFeedbackSettled } from "./pressFeedback";

export async function tryWriteClipboard(value: string) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    notifyPressFeedbackSettled();
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  } finally {
    notifyPressFeedbackSettled();
  }
}
