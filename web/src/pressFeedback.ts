export const PRESS_FEEDBACK_SETTLED_EVENT = "auditable-voting:press-feedback-settled";

export function notifyPressFeedbackSettled() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(PRESS_FEEDBACK_SETTLED_EVENT));
}
