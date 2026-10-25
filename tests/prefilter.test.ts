import { describe, expect, it } from "vitest";
import { looksLikeJobPost } from "../src/pipeline/prefilter.js";

describe("looksLikeJobPost", () => {
  it.each([
    ["", false],
    ["   ", false],
    ["תודה רבה!", false],
    ["Thanks!", false],
    ["Hiring dev", false], // too short
    ["מישהו יודע איפה אפשר לחנות ליד האוניברסיטה בערב? תודה מראש לכולם", false],
    ["Anyone knows a good restaurant near the office for a team lunch tomorrow?", false],
    ["דרוש/ה מפתח/ת Python למשרה מלאה בתל אביב, שלחו קורות חיים", true],
    ["We're hiring a Backend Engineer in Tel Aviv, hybrid, 3+ years Python", true],
    ["Send your details to talent@example.com and we'll get back to you soon", true],
    ["משרת סטודנט/ית בתחום ה-Data, 3 ימים בשבוע, רחובות", true],
    ["Looking for a Data Scientist with strong ML background for our team", true],
    ["Join our team! Remote-friendly startup building geospatial analytics", true],
  ])("%s → %s", (text, expected) => {
    expect(looksLikeJobPost(text)).toBe(expected);
  });
  it("does not match keyword inside other words", () => {
    expect(looksLikeJobPost("the injoba bananas were great at the market place yesterday")).toBe(
      false,
    );
  });
});
