// Fictional job posts for tests. No real companies, people or contact details.
import type { JobPost } from "../../src/pipeline/extract.js";

export function jobPost(over: Partial<JobPost> = {}): JobPost {
  return {
    title: "Backend Engineer",
    company: "Example Labs",
    location: "Tel Aviv",
    region: "tel_aviv",
    workMode: "hybrid",
    jobType: "full_time",
    scopePercent: null,
    salary: null,
    seniority: "mid",
    yearsExperience: 3,
    skills: ["Python", "FastAPI", "PostgreSQL"],
    requirements: ["3+ years Python", "Experience with REST APIs"],
    summary: "Build backend services for a data platform.",
    apply: { kind: "email", target: "jobs@example.com" },
    language: "en",
    ...over,
  };
}

export const POST_HE =
  "דרוש/ה מפתח/ת Backend לחברת Example Labs בתל אביב, היברידי. 3+ שנות ניסיון ב-Python. קו״ח ל-jobs@example.com";
