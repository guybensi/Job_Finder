// Cheap, deterministic first pass: drop chit-chat before anything reaches the model.
// It errs on the side of letting posts through; the model makes the real call.

const KEYWORDS = [
  // Hebrew
  "דרוש",
  "דרושה",
  "דרושים",
  "דרושות",
  "משרה",
  "משרת",
  "משרות",
  "מגייס",
  "מגייסת",
  "מגייסים",
  "גיוס",
  "קו״ח",
  'קו"ח',
  "קוח",
  "קורות חיים",
  "מחפשים",
  "מחפשת",
  "מחפש",
  "הצטרף",
  "הצטרפ",
  "תפקיד",
  "סטודנט",
  "מפתח",
  "מהנדס",
  "חברת",
  // English
  "hiring",
  "job",
  "position",
  "role",
  "looking for",
  "join",
  "developer",
  "engineer",
  "scientist",
  "researcher",
  "analyst",
  "student",
  "intern",
  "apply",
  "cv",
  "resume",
  "careers",
  "vacancy",
  "opening",
];

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const MIN_LENGTH = 40;

/**
 * Decide whether a group message might be a job post and is worth sending to the model.
 *
 * Example:
 *   looksLikeJobPost("Thanks!")                                              // → false
 *   looksLikeJobPost("דרוש/ה מפתח/ת Python למשרה מלאה, קו״ח ל-jobs@x.com") // → true
 *
 * @param text The raw message text.
 * @returns `true` when the text is long enough and has a job keyword or an email address.
 */
export function looksLikeJobPost(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_LENGTH) return false;
  if (EMAIL.test(t)) return true;
  const lower = t.toLowerCase();
  return KEYWORDS.some((k) => {
    if (/^[a-z ]+$/.test(k)) return new RegExp(`\\b${k}`).test(lower);
    return lower.includes(k);
  });
}
