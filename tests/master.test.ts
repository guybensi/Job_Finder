import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cvForMatch,
  cvForPrompt,
  cvSummary,
  loadMaster,
  mergeCv,
  saveMaster,
  sourceWarnings,
} from "../src/cv/master.js";
import { master, parsedLlm, parsedRs } from "./fixtures/cv.js";

const LLM = "backend-engineer-python";
const RS = "vision-data-engineer-ima";

describe("mergeCv", () => {
  it("first upload creates variant and ids", () => {
    const m = mergeCv(null, parsedLlm);
    expect(m.variants.map((v) => v.id)).toEqual([LLM]);
    expect(m.items.map((i) => i.id)).toEqual(["exp-1", "edu-1", "skl-1"]);
  });
  it("second upload merges into the fixture master", () => {
    expect(mergeCv(mergeCv(null, parsedLlm), parsedRs)).toEqual(master);
  });
  it("re-uploading the same variant replaces it (removed items vanish, ids kept)", () => {
    const m = mergeCv(master, { ...parsedRs, items: parsedRs.items.slice(0, 1) });
    expect(m.variants).toHaveLength(2);
    expect(m.items.find((i) => i.id === "prj-1")).toBeUndefined();
    expect(m.items.find((i) => i.id === "exp-1")!.variants).toEqual([LLM, RS]);
    expect(m.items.find((i) => i.id === "edu-1")!.variants).toEqual([LLM]);
  });
  it("different headline with same slug prefix gets a unique id", () => {
    const m = mergeCv(master, { ...parsedLlm, headline: "Backend Engineer (Python) v2" });
    expect(m.variants.map((v) => v.id)).toEqual([LLM, RS]);
    const m2 = mergeCv(master, { ...parsedLlm, headline: "Backend-Engineer, Python!!" });
    expect(m2.variants).toHaveLength(2);
  });
  it("drops empty items, trims bullets, dedupes bullets case-insensitively", () => {
    const m = mergeCv(null, {
      ...parsedLlm,
      items: [
        { section: "other", heading: " ", subheading: null, dates: null, bullets: [" "] },
        {
          section: "experience",
          heading: "Dev",
          subheading: null,
          dates: null,
          bullets: [" A thing "],
        },
      ],
    });
    expect(m.items).toEqual([
      expect.objectContaining({ id: "exp-1", bullets: ["A thing"], subheading: null }),
    ]);
    const m2 = mergeCv(m, {
      ...parsedRs,
      items: [
        {
          section: "experience",
          heading: "dev",
          subheading: null,
          dates: null,
          bullets: ["a thing", "B"],
        },
      ],
    });
    expect(m2.items[0]!.bullets).toEqual(["A thing", "B"]);
  });
  it("does not mutate input and rejects missing headline", () => {
    const copy = structuredClone(master);
    mergeCv(master, parsedRs);
    expect(master).toEqual(copy);
    expect(() => mergeCv(null, { ...parsedLlm, headline: " " })).toThrow(/headline/);
  });
  it("empty slug falls back to 'cv'", () => {
    expect(mergeCv(null, { ...parsedLlm, headline: "מהנדס" }).variants[0]!.id).toBe("cv");
  });
});

describe("master helpers", () => {
  it("sourceWarnings flags changed numbers, accepts thousands separators", () => {
    const text =
      "Built a retrieval service serving 2000 requests. Cut latency by 40%. 2022 – 2024 2020 2023 3 92";
    expect(sourceWarnings(parsedLlm, text)).toEqual([]);
    const w = sourceWarnings({ ...parsedLlm, summary: "Cut latency by 45%" }, text);
    expect(w).toEqual(['"Cut latency by 45%": 45 is not in the PDF']);
  });
  it("cvForPrompt lists ids, variants and bullets", () => {
    const t = cvForPrompt(master);
    expect(t).toContain(
      `[exp-1] Software Engineer — Acme Analytics | 2022 – 2024 (variants: ${LLM}, ${RS})`,
    );
    expect(t).toContain("  - Cut API latency by 40% with caching");
    expect(t.indexOf("## experience")).toBeLessThan(t.indexOf("## projects"));
  });
  it("cvSummary with warnings", () => {
    const s = cvSummary(master, ["x"]);
    expect(s).toContain("• Vision & Data Engineer (Imaging)");
    expect(s).toContain("education: M.Sc. Computer Science");
    expect(s).toContain("- x");
  });
  it("save/load roundtrip; missing → null; invalid → throws", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "jf-"));
    expect(loadMaster(dir)).toBeNull();
    saveMaster(dir, master);
    expect(loadMaster(dir)).toEqual(master);
    expect(() => saveMaster(dir, { ...master, variants: [] })).toThrow();
  });
});

describe("cvForMatch", () => {
  it("headings and skills only, much shorter", () => {
    const t = cvForMatch(master);
    expect(t).toContain("experience: Software Engineer (Acme Analytics, 2022 – 2024)");
    expect(t).toContain("skills: Languages: Python, TypeScript, SQL");
    expect(t).toContain(`Variant ${LLM}: Backend Engineer (Python/APIs) — `);
    expect(t).not.toContain("Cut API latency");
    expect(t.length).toBeLessThan(cvForPrompt(master).length * 0.7);
  });
});
