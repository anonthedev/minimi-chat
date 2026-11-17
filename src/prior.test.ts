import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretPrior, NO_PRIOR } from "./prior.ts";

describe("interpretPrior", () => {
  it("keeps the no-prior answer", () => {
    assert.deepEqual(interpretPrior({ answer: NO_PRIOR, query: "postgres" }), { answer: NO_PRIOR });
  });

  it("treats an empty lookup as no prior", () => {
    assert.deepEqual(interpretPrior({ answer: "recall" }), { answer: NO_PRIOR });
  });

  it("keeps a range and keywords", () => {
    assert.deepEqual(interpretPrior({ answer: "recall", start: " 2026-11-10 ", end: "2026-11-11T00:00:00", query: "postgres hosting" }), {
      answer: "recall",
      start: "2026-11-10",
      end: "2026-11-11",
      query: "postgres hosting",
    });
  });

  it("keeps an impossible time as an error", () => {
    assert.deepEqual(interpretPrior({ answer: "recall", start: "2026-11-10", error: " 31 November " }), {
      answer: "recall",
      error: "31 November",
    });
  });

  it("keeps keywords alone for a follow-up", () => {
    assert.deepEqual(interpretPrior({ answer: "recall", query: "postgres hosting" }), {
      answer: "recall",
      query: "postgres hosting",
    });
  });
});
