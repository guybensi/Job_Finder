import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { parseCv, pdfText } from "../src/cv/master.js";
import { cvFileName, pdfSafe, renderPdf } from "../src/cv/render.js";
import { type TailoredCv, untailored } from "../src/cv/tailor.js";
import { FakeLlm } from "../src/llm.js";
import { master, parsedLlm } from "./fixtures/cv.js";

const LLM = "backend-engineer-python";

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

describe("render + parse", () => {
  it("pdfSafe and file name", () => {
    expect(pdfSafe("a‑b – c • 😀 שלום")).toBe("a-b – c • ? ????");
    expect(cvFileName("Dana Example")).toBe("Dana_Example_CV.pdf");
    expect(cvFileName("דנה")).toBe("CV_CV.pdf");
  });
  it("renders a PDF whose text has name, contact, headings and bullets", async () => {
    const pdf = await renderPdf(master, good);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = await pdfText(pdf);
    for (const s of [
      "Dana Example",
      "dana@example.com",
      "EXPERIENCE",
      "Software Engineer",
      "2,000 requests",
      "SKILLS",
    ]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("Cut API latency");
    expect(text).not.toContain("PROJECTS");
  });
  it("render rejects unknown item", () => {
    expect(() => renderPdf(master, { ...good, items: [{ id: "zzz", bullets: [] }] })).toThrow(
      /zzz/,
    );
  });
  it("parseCv sends pdf + extracted text; rejects empty pdf", async () => {
    const pdf = await renderPdf(master, untailored(master, LLM, "x"));
    const llm = new FakeLlm(() => parsedLlm);
    expect(await parseCv(llm, "m", pdf)).toEqual(parsedLlm);
    expect(llm.calls[0]!.pdfs).toHaveLength(1);
    expect(llm.calls[0]!.prompt).toContain("<cv>");
    expect(llm.calls[0]!.prompt).toContain("Acme Analytics");
    const blank = new PDFDocument();
    const chunks: Buffer[] = [];
    blank.on("data", (c: Buffer) => chunks.push(c));
    const ended = new Promise((r) => blank.on("end", r));
    blank.text("Hi");
    blank.end();
    await ended;
    const empty = Buffer.concat(chunks);
    await expect(parseCv(llm, "m", empty)).rejects.toThrow(/no text/);
  });
});
