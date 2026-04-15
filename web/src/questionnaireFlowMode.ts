export type QuestionnaireFlowMode = "legacy" | "option_a";

export function getQuestionnaireFlowMode(search = typeof window !== "undefined" ? window.location.search : ""): QuestionnaireFlowMode {
  const params = new URLSearchParams(search);
  const value = (params.get("questionnaire_flow") ?? params.get("qflow") ?? "").trim().toLowerCase();
  return value === "option_a" ? "option_a" : "legacy";
}
