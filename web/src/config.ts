export const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export const COORDINATOR_URL = USE_MOCK
  ? "http://localhost:8787"
  : (import.meta.env.VITE_COORDINATOR_URL as string);

export const MINT_URL = USE_MOCK
  ? "http://localhost:8787/mock-mint"
  : (import.meta.env.VITE_MINT_URL as string);

export const DEMO_COPY = {
  pass: "voting pass",
  quote: "approval request",
  proof: "voting pass",
  mint: "issuer",
};
