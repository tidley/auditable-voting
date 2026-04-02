export const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
const MOCK_SERVER_URL = "http://localhost:8789";

export const COORDINATOR_URL = USE_MOCK
  ? MOCK_SERVER_URL
  : (import.meta.env.VITE_COORDINATOR_URL as string);

export const MINT_URL = USE_MOCK
  ? `${MOCK_SERVER_URL}/mock-mint`
  : (import.meta.env.VITE_MINT_URL as string);

export const DEMO_COPY = {
  pass: "voting pass",
  quote: "approval request",
  proof: "voting pass",
  mint: "issuer",
};
