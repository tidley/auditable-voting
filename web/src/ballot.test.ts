import { describe, expect, it } from "vitest";
import { isBallotComplete } from "./ballot";

describe("isBallotComplete", () => {
  it("requires all questions to be answered", () => {
    const questions = [
      { id: "q1", type: "choice", prompt: "A" },
      { id: "q2", type: "text", prompt: "B" },
    ] as any;

    expect(isBallotComplete({ q1: "yes" }, questions)).toBe(false);
    expect(isBallotComplete({ q1: "yes", q2: "hello" }, questions)).toBe(true);
  });

  it("requires at least one option for multi-select questions", () => {
    const questions = [
      { id: "q1", type: "choice", select: "multiple", prompt: "A" },
    ] as any;

    expect(isBallotComplete({ q1: [] }, questions)).toBe(false);
    expect(isBallotComplete({ q1: ["x"] }, questions)).toBe(true);
  });
});
