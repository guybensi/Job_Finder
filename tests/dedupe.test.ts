import { describe, expect, it } from "vitest";
import { findDuplicate, fingerprint, jaccard, normalize } from "../src/pipeline/dedupe.js";
import { jobPost } from "./fixtures/jobs.js";

describe("dedupe", () => {
  it("normalize keeps hebrew and digits", () => {
    expect(normalize("  מפתח/ת Backend, C++!! 3+ ")).toBe("מפתח ת backend c 3");
    expect(normalize(null)).toBe("");
  });
  it("jaccard", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
  });
  it("fingerprint ignores case and punctuation", () => {
    expect(fingerprint(jobPost({ title: "Backend Engineer!" }))).toBe(
      fingerprint(jobPost({ title: "backend   engineer" })),
    );
    expect(fingerprint(jobPost())).toBe("example labs|backend engineer|jobs example com");
  });
  it("no recent → -1", () => {
    expect(findDuplicate(jobPost(), [])).toBe(-1);
  });
  it("identical repost", () => {
    expect(findDuplicate(jobPost(), [jobPost({ title: "Other" }), jobPost()])).toBe(1);
  });
  it("same email similar title", () => {
    expect(
      findDuplicate(jobPost({ title: "Senior Backend Engineer", company: null }), [jobPost()]),
    ).toBe(0);
  });
  it("same email very different title is not a duplicate (company hiring several roles)", () => {
    expect(
      findDuplicate(jobPost({ title: "Data Scientist", skills: ["ML"], requirements: ["PhD"] }), [
        jobPost(),
      ]),
    ).toBe(-1);
  });
  it("same company near-identical title different contact", () => {
    expect(
      findDuplicate(jobPost({ apply: { kind: "link", target: "https://x.example/1" } }), [
        jobPost(),
      ]),
    ).toBe(0);
  });
  it("different company same title is not a duplicate", () => {
    expect(
      findDuplicate(
        jobPost({
          company: "Another Co",
          apply: { kind: "email", target: "hr@another.example" },
          skills: ["Go"],
          requirements: ["Kubernetes"],
        }),
        [jobPost()],
      ),
    ).toBe(-1);
  });
  it("unknown company, unknown contact, same content → duplicate", () => {
    const a = jobPost({ company: null, apply: { kind: "unknown", target: null } });
    expect(
      findDuplicate(a, [jobPost({ company: null, apply: { kind: "unknown", target: null } })]),
    ).toBe(0);
  });
  it("unknown company and contact, different content → not duplicate", () => {
    const base = { company: null, apply: { kind: "unknown" as const, target: null } };
    expect(
      findDuplicate(
        jobPost({ ...base, title: "QA Engineer", skills: ["Selenium"], requirements: [] }),
        [jobPost(base)],
      ),
    ).toBe(-1);
  });
});
