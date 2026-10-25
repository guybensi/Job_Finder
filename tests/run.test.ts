import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, type Profile } from "../src/config.js";
import type { TailoredCv } from "../src/cv/tailor.js";
import { FakeLlm, type LlmRequest } from "../src/llm.js";
import { EXTRACT_SYSTEM, type JobPost } from "../src/pipeline/extract.js";
import { MATCH_SYSTEM } from "../src/pipeline/match.js";
import { formatSalary, runPipeline, toCard } from "../src/pipeline/run.js";
import { openStore, type JobRecord, type Store } from "../src/store.js";
import { T } from "../src/telegram/texts.js";
import { master } from "./fixtures/cv.js";
import { jobPost, POST_HE } from "./fixtures/jobs.js";
import type { z } from "zod";

const profile: Profile = {
  ...DEFAULT_PROFILE,
  regions: ["center"],
  minScore: 60,
  maxTailoredPerRun: 8,
};
const LLM = "backend-engineer-python";
const tailored: TailoredCv = {
  variant: LLM,
  headline: "Backend Engineer (Python/APIs)",
  summary: "Backend engineer building LLM-powered services in Python.",
  items: [{ id: "exp-1", bullets: ["Cut API latency by 40% with caching"] }],
  coverMessage:
    "Hello, I'd like to apply for the Backend Engineer role. Best regards, Dana Example",
};

interface Script {
  jobsFor?: (text: string) => JobPost[];
  score?: number;
  extractFails?: boolean;
  scoreFails?: boolean;
}

function fakeLlm(s: Script = {}) {
  return new FakeLlm((req: LlmRequest<z.ZodType>) => {
    if (req.system === EXTRACT_SYSTEM) {
      if (s.extractFails) throw new Error("api down");
      const ids = [...req.prompt.matchAll(/messageId: (\d+)\n<post>\n([\s\S]*?)\n<\/post>/g)];
      return {
        results: ids.map(([, id, text]) => ({
          messageId: Number(id),
          jobs: (s.jobsFor ?? (() => [jobPost({ region: "center" })]))(text!),
        })),
      };
    }
    if (req.system === MATCH_SYSTEM) {
      if (s.scoreFails) throw new Error("score boom");
      return { score: s.score ?? 85, reasons: ["Python"], concerns: [], variant: LLM };
    }
    return tailored;
  });
}

function seed(store: Store, texts: string[], ts = 1000) {
  texts.forEach((text, i) =>
    store.insertMessage({
      waId: `w${ts}-${i}`,
      groupId: "g@g.us",
      groupName: "Group A",
      sender: "s",
      text,
      ts,
    }),
  );
}

function deps(store: Store, llm: FakeLlm, over: Partial<Parameters<typeof runPipeline>[0]> = {}) {
  const cards: JobRecord[] = [];
  return {
    cards,
    d: {
      store,
      llm,
      models: { extract: "mx", tailor: "mt" },
      profile,
      master,
      sendCard: async (j: JobRecord) => void cards.push(j),
      now: () => 10_000,
      ...over,
    },
  };
}

describe("runPipeline", () => {
  it("empty store does nothing", async () => {
    const store = openStore(":memory:");
    const llm = fakeLlm();
    const { d } = deps(store, llm);
    expect(await runPipeline(d)).toMatchObject({ messages: 0, jobs: 0, ready: 0, errors: [] });
    expect(llm.calls).toHaveLength(0);
  });
  it("chit-chat is marked processed without model calls", async () => {
    const store = openStore(":memory:");
    seed(store, ["תודה!"]);
    const llm = fakeLlm();
    const r = await runPipeline(deps(store, llm).d);
    expect(r).toMatchObject({ messages: 1, candidates: 0 });
    expect(store.pendingMessages(10)).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });
  it("job post → ready card with draft", async () => {
    const store = openStore(":memory:");
    seed(store, [POST_HE]);
    const { d, cards } = deps(store, fakeLlm());
    const r = await runPipeline(d);
    expect(r).toMatchObject({ candidates: 1, jobs: 1, ready: 1, errors: [] });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      status: "ready",
      score: 85,
      reasons: ["Python"],
      groupName: "Group A",
    });
    expect(store.pendingMessages(10)).toEqual([]);
  });
  it("same post in two groups → one job, one duplicate; repost next run also duplicate", async () => {
    const store = openStore(":memory:");
    seed(store, [POST_HE, POST_HE + " "]);
    const { d } = deps(store, fakeLlm());
    expect(await runPipeline(d)).toMatchObject({ jobs: 1, duplicates: 1, ready: 1 });
    seed(store, [POST_HE], 2000);
    expect(await runPipeline(d)).toMatchObject({ jobs: 0, duplicates: 1 });
  });
  it("hard filter and low score", async () => {
    const store = openStore(":memory:");
    seed(store, [POST_HE]);
    const llm = fakeLlm({ jobsFor: () => [jobPost({ region: "haifa", workMode: "onsite" })] });
    expect(await runPipeline(deps(store, llm).d)).toMatchObject({ filtered: 1, ready: 0 });
    expect(store.jobsByStatus("filtered")[0]!.reasons).toEqual(["region haifa not in profile"]);
    expect(llm.calls).toHaveLength(1);

    const store2 = openStore(":memory:");
    seed(store2, [POST_HE]);
    expect(await runPipeline(deps(store2, fakeLlm({ score: 40 })).d)).toMatchObject({
      lowScore: 1,
      ready: 0,
    });
    expect(store2.jobsByStatus("low_score")[0]!.score).toBe(40);
  });
  it("no CV: jobs wait, then get processed once a CV exists", async () => {
    const store = openStore(":memory:");
    seed(store, [POST_HE]);
    const llm = fakeLlm();
    expect(await runPipeline(deps(store, llm, { master: null }).d)).toMatchObject({
      jobs: 1,
      waiting: 1,
      ready: 0,
    });
    const { d, cards } = deps(store, llm);
    expect(await runPipeline(d)).toMatchObject({ messages: 0, ready: 1 });
    expect(cards).toHaveLength(1);
  });
  it("per-run tailoring limit", async () => {
    const store = openStore(":memory:");
    seed(store, [POST_HE]);
    const llm = fakeLlm({
      jobsFor: () => [
        jobPost({ region: "center", title: "Backend Engineer" }),
        jobPost({
          region: "center",
          title: "Data Scientist",
          company: "Other",
          apply: { kind: "email", target: "jobs@example.com" },
          skills: ["R"],
          requirements: ["Stats"],
        }),
      ],
    });
    const r = await runPipeline(
      deps(store, llm, { profile: { ...profile, maxTailoredPerRun: 1 } }).d,
    );
    expect(r).toMatchObject({ jobs: 2, ready: 1, waiting: 1 });
  });
  it("extract failure leaves messages pending; score failure retries for a day, then fails", async () => {
    const store = openStore(":memory:");
    seed(store, [POST_HE]);
    const r = await runPipeline(deps(store, fakeLlm({ extractFails: true })).d);
    expect(r.errors).toEqual(["extract: api down"]);
    expect(store.pendingMessages(10)).toHaveLength(1);

    const r2 = await runPipeline(deps(store, fakeLlm({ scoreFails: true })).d);
    expect(r2.errors).toEqual([expect.stringMatching(/score boom/)]);
    expect(store.jobsByStatus("new")).toHaveLength(1); // retried next run
    const dayLater = deps(store, fakeLlm({ scoreFails: true }), {
      now: () => 10_000 + 25 * 3600_000,
    });
    await runPipeline(dayLater.d);
    expect(store.jobsByStatus("failed")).toHaveLength(1);
  });
  it("learned skip reasons reach the match prompt", async () => {
    const store = openStore(":memory:");
    const old = store.insertJob(
      {
        fingerprint: "x",
        messageId: null,
        groupName: "G",
        post: jobPost({ title: "QA Tester", company: "Old Co" }),
      },
      0,
    );
    store.recordDecision(old, "skip", "not my field");
    seed(store, [POST_HE]);
    const llm = fakeLlm();
    await runPipeline(deps(store, llm).d);
    const matchCall = llm.calls.find((c) => c.system === MATCH_SYSTEM)!;
    expect(matchCall.prompt).toContain('- Skipped "QA Tester" at Old Co: not my field');
  });
});

describe("toCard / formatSalary", () => {
  it("formatSalary", () => {
    expect(formatSalary(null)).toBeNull();
    expect(formatSalary({ min: null, max: null, period: "month", currency: "ILS" })).toBeNull();
    expect(formatSalary({ min: 30000, max: 35000, period: "month", currency: "ILS" })).toBe(
      "30,000–35,000 ₪/month",
    );
    expect(formatSalary({ min: 60, max: null, period: "hour", currency: "ILS" })).toBe("60 ₪/hour");
    expect(formatSalary({ min: 100, max: 100, period: "year", currency: "USD" })).toBe(
      "100 $/year",
    );
  });
  it("builds card from ready job; null for broken draft; fallback concern", async () => {
    const store = openStore(":memory:");
    seed(store, [POST_HE]);
    const { d, cards } = deps(store, fakeLlm());
    await runPipeline(d);
    const card = toCard(cards[0]!, master)!;
    expect(card).toMatchObject({
      title: "Backend Engineer",
      location: "Tel Aviv, hybrid",
      score: 85,
      cvVariant: "Backend Engineer (Python/APIs)",
      apply: { kind: "email", target: "jobs@example.com" },
      group: "Group A",
    });
    expect(toCard({ ...cards[0]!, draft: null }, master)).toBeNull();
    const fb = { ...cards[0]!, draft: { ...(cards[0]!.draft as object), fallback: true } };
    expect(toCard(fb, master)!.concerns).toContain(T.cvNotTailored);
    expect(toCard(cards[0]!, null)!.cvVariant).toBeNull();
  });
});
