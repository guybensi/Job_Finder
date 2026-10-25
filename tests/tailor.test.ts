import { describe, expect, it } from "vitest";
import {
  factTokens,
  fallbackCover,
  tailorCv,
  type TailoredCv,
  untailored,
  validateTailored,
} from "../src/cv/tailor.js";
import { FakeLlm } from "../src/llm.js";
import { master } from "./fixtures/cv.js";
import { jobPost } from "./fixtures/jobs.js";

const LLM = "backend-engineer-python";
const RS = "vision-data-engineer-ima";
const job = jobPost();

const good: TailoredCv = {
  variant: LLM,
  headline: "Backend Engineer (Python/APIs)",
  summary: "Backend engineer building LLM-powered services in Python.",
  items: [
    {
      id: "exp-1",
      bullets: ["Built a Python retrieval service serving 2,000 requests per minute"],
    },
    { id: "skl-1", bullets: ["Python, SQL"] },
  ],
  coverMessage:
    "Hello,\n\nI'd like to apply for the Backend Engineer position at Example Labs. I built a Python retrieval service and cut API latency by 40%.\n\nBest regards,\nDana Example",
};

describe("factTokens / validateTailored", () => {
  it("factTokens", () => {
    expect(factTokens("Built APIs at Google with PyTorch and C++.")).toEqual([
      "APIs",
      "Google",
      "PyTorch",
      "C++",
    ]);
    expect(factTokens("Led the team. Shipped weekly")).toEqual([]);
    expect(factTokens("I'm a CV fan, Hello")).toEqual([]);
    expect(factTokens("worked 3 years (2020)")).toEqual(["3", "2020"]);
    expect(factTokens("")).toEqual([]);
  });
  it("accepts a faithful tailoring", () => {
    expect(validateTailored(master, good, job)).toEqual({ ok: true, errors: [] });
  });
  it("accepts the untailored variant and fallback cover", () => {
    const t = untailored(master, RS, fallbackCover(job, master.name));
    expect(validateTailored(master, t, job).errors).toEqual([]);
  });
  it("rejects unknown item, duplicate item, unknown variant, empty items", () => {
    const r = validateTailored(
      master,
      {
        ...good,
        variant: "x",
        items: [
          { id: "exp-9", bullets: [] },
          { id: "edu-1", bullets: [] },
          { id: "edu-1", bullets: [] },
        ],
      },
      job,
    );
    expect(r.errors).toEqual(
      expect.arrayContaining([
        "variant x does not exist",
        "item exp-9 does not exist",
        "item edu-1 appears twice",
      ]),
    );
    expect(validateTailored(master, { ...good, items: [] }, job).errors).toContain(
      "no items selected",
    );
  });
  it("rejects a changed number and a number from another item", () => {
    const r = validateTailored(
      master,
      {
        ...good,
        items: [
          { id: "exp-1", bullets: ["Cut API latency by 60%"] },
          { id: "prj-1", bullets: ["Cut latency by 40%"] },
        ],
      },
      job,
    );
    expect(r.errors).toEqual([
      "exp-1: number 60 is not in this item",
      "prj-1: number 40 is not in this item",
    ]);
  });
  it("rejects new employer / tool and too many bullets", () => {
    const r = validateTailored(
      master,
      {
        ...good,
        items: [
          { id: "skl-1", bullets: ["Python, Kubernetes"] },
          { id: "edu-1", bullets: ["Graduated from Stanford"] },
        ],
      },
      job,
    );
    expect(r.errors).toEqual([
      'skl-1: "Kubernetes" is not in the CV',
      "edu-1: 1 bullets but the CV has 0",
      'edu-1: "Stanford" is not in the CV',
    ]);
  });
  it("summary/headline checked against whole CV", () => {
    expect(
      validateTailored(master, { ...good, summary: "Engineer with 10 years at Google." }, job)
        .errors,
    ).toEqual(["summary: number 10 is not in the CV", 'summary: "Google" is not in the CV']);
    expect(
      validateTailored(
        master,
        { ...good, summary: "Engineer with 2,000 rpm services in Python." },
        job,
      ).ok,
    ).toBe(true);
  });
  it("cover may use job words but not invented facts; empty cover rejected", () => {
    expect(
      validateTailored(
        master,
        { ...good, coverMessage: "Excited about FastAPI at Example Labs." },
        job,
      ).ok,
    ).toBe(true);
    expect(
      validateTailored(master, { ...good, coverMessage: "I have 7 years with Rust." }, job).errors,
    ).toEqual([
      "cover message: number 7 is not in the CV",
      'cover message: "Rust" is not in the CV',
    ]);
    expect(validateTailored(master, { ...good, coverMessage: " " }, job).errors).toContain(
      "cover message is empty",
    );
  });
  it("hebrew cover with job numbers passes", () => {
    const he = jobPost({ language: "he", requirements: ["3+ שנות ניסיון"] });
    expect(
      validateTailored(
        master,
        { ...good, coverMessage: "שלום, יש לי ניסיון ב-Python ו-3 שנים בתחום." },
        he,
      ).ok,
    ).toBe(true);
    expect(
      validateTailored(master, { ...good, coverMessage: "עבדתי ב-Google." }, he).errors,
    ).toEqual(['cover message: "Google" is not in the CV']);
  });
});

describe("tailorCv", () => {
  it("returns first valid answer", async () => {
    const llm = new FakeLlm(() => good);
    expect(await tailorCv(llm, "m", master, job, LLM)).toEqual({
      tailored: good,
      errors: [],
      fallback: false,
    });
    expect(llm.calls[0]!.prompt).toContain(`Start from variant: ${LLM}`);
  });
  it("retries with errors then succeeds", async () => {
    let n = 0;
    const bad = { ...good, summary: "10 years at Google" };
    const llm = new FakeLlm(() => (n++ === 0 ? bad : good));
    const r = await tailorCv(llm, "m", master, job, LLM);
    expect(r.fallback).toBe(false);
    expect(llm.calls[1]!.prompt).toContain('- summary: "Google" is not in the CV');
  });
  it("falls back to untailored after two failures", async () => {
    const llm = new FakeLlm(() => ({ ...good, summary: "10 years at Google" }));
    const r = await tailorCv(llm, "m", master, job, RS);
    expect(r.fallback).toBe(true);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.tailored.items.map((i) => i.id)).toEqual(["exp-1", "edu-1", "prj-1"]);
    expect(r.tailored.coverMessage).toContain("Backend Engineer position at Example Labs");
    expect(llm.calls).toHaveLength(2);
  });
  it("unknown variant throws before calling the model", async () => {
    const llm = new FakeLlm(() => good);
    await expect(tailorCv(llm, "m", master, job, "nope")).rejects.toThrow(/does not exist/);
    expect(llm.calls).toHaveLength(0);
  });
  it("fallbackCover hebrew", () => {
    expect(fallbackCover(jobPost({ language: "he", company: null }), "Dana")).toBe(
      "שלום,\n\nאשמח להגיש מועמדות למשרת Backend Engineer. קורות החיים שלי מצורפים.\n\nבברכה,\nDana",
    );
  });
});
