import PDFDocument from "pdfkit";
import type { MasterCv, Section } from "./master.js";
import type { TailoredCv } from "./tailor.js";

const TITLES: Record<Section, string> = {
  experience: "Experience",
  projects: "Projects",
  education: "Education",
  publications: "Publications",
  skills: "Skills",
  other: "Other",
};

// Order on the page: what recruiters read first.
const PAGE_ORDER: Section[] = [
  "experience",
  "projects",
  "education",
  "publications",
  "skills",
  "other",
];

/**
 * Replace characters the built-in PDF fonts cannot draw (WinAnsi) with close ASCII, so the
 * PDF never shows garbage. CVs are English; anything else becomes "?".
 */
export function pdfSafe(text: string): string {
  return text
    .replace(/[\u2010\u2011\u2012\u2212]/g, "-")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(
      /[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC\n]/gu,
      "?",
    );
}

/**
 * Render a tailored CV as an A4 PDF. Name and contact details come from the master CV,
 * never from the model; item headings and dates are the master's own.
 *
 * Example:
 *   const pdf = await renderPdf(master, tailored);  // → Buffer starting with "%PDF-"
 *
 * @throws Error if the tailored CV references an item that is not in the master.
 */
export function renderPdf(master: MasterCv, tailored: TailoredCv): Promise<Buffer> {
  const items = tailored.items.map((t) => {
    const source = master.items.find((i) => i.id === t.id);
    if (!source) throw new Error(`item ${t.id} does not exist`);
    return { ...source, bullets: t.bullets };
  });

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 42, bottom: 42, left: 50, right: 50 },
    info: { Title: `${master.name} - CV`, Author: master.name },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;

  doc.font("Helvetica-Bold").fontSize(20).text(pdfSafe(master.name), { align: "left" });
  doc.font("Helvetica").fontSize(11.5).fillColor("#333333").text(pdfSafe(tailored.headline));
  const contact = [
    master.contact.email,
    master.contact.phone,
    master.contact.location,
    ...master.contact.links,
  ].filter(Boolean);
  if (contact.length)
    doc
      .fontSize(9)
      .fillColor("#555555")
      .text(pdfSafe(contact.join("  |  ")));
  doc.fillColor("black");

  const heading = (title: string) => {
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(11).text(title.toUpperCase(), { characterSpacing: 0.5 });
    const y = doc.y + 1;
    doc
      .moveTo(left, y)
      .lineTo(left + width, y)
      .lineWidth(0.6)
      .strokeColor("#999999")
      .stroke();
    doc.moveDown(0.35);
  };

  if (tailored.summary.trim()) {
    heading("Summary");
    doc.font("Helvetica").fontSize(9.5).text(pdfSafe(tailored.summary), { align: "justify" });
  }

  for (const section of PAGE_ORDER) {
    const list = items.filter((i) => i.section === section);
    if (!list.length) continue;
    heading(TITLES[section]);
    for (const item of list) {
      if (section === "skills") {
        doc
          .font("Helvetica-Bold")
          .fontSize(9.5)
          .text(`${pdfSafe(item.heading)}: `, { continued: true })
          .font("Helvetica")
          .text(pdfSafe(item.bullets.join("; ")));
        continue;
      }
      const top = doc.y;
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(pdfSafe(item.heading), left, top, {
          width: width - 110,
        });
      const afterHeading = doc.y;
      if (item.dates) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#555555")
          .text(pdfSafe(item.dates), left + width - 110, top + 1, { width: 110, align: "right" })
          .fillColor("black");
      }
      doc.x = left;
      doc.y = Math.max(afterHeading, doc.y);
      if (item.subheading) {
        doc.font("Helvetica-Oblique").fontSize(9.5).text(pdfSafe(item.subheading));
      }
      if (item.bullets.length) {
        doc.font("Helvetica").fontSize(9.5);
        doc.list(item.bullets.map(pdfSafe), { bulletRadius: 1.5, indent: 10, textIndent: 10 });
      }
      doc.moveDown(0.4);
    }
  }

  doc.end();
  return done;
}

/** File name for the attached CV, e.g. "Dana_Example_CV.pdf". */
export function cvFileName(name: string): string {
  const base = pdfSafe(name)
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${base || "CV"}_CV.pdf`;
}
