// Every text the bot sends to the owner. Hebrew; job content itself stays in its own language.

export const T = {
  help: [
    "שלום! אני סורק את קבוצות הדרושים ושולח לך משרות שמתאימות לך.",
    "",
    "/status – מצב המערכת",
    "/scan – סריקה עכשיו",
    "/pause, /resume – השהיה וחידוש של הסריקות",
    "/groups – בחירת הקבוצות שנסרקות",
    "/profile – הצגת הפרופיל (לעדכון: /setprofile ואחריו YAML באותה הודעה)",
    "/cv – העלאת קורות חיים (שלח קובץ PDF)",
  ].join("\n"),
  unknownCommand: "לא מכיר את הפקודה הזאת. /help לרשימת הפקודות.",
  paused: "הסריקות הושהו. /resume כדי לחדש.",
  resumed: "הסריקות חודשו.",
  scanStarted: "מתחיל סריקה…",
  scanBusy: "סריקה כבר רצה כרגע.",
  noGroups: "עוד לא ראיתי אף קבוצה. ודא שהוואטסאפ מחובר.",
  groupsTitle: "לחץ על קבוצה כדי להוסיף או להסיר אותה מהסריקה (✅ = נסרקת):",
  profileTitle: "הפרופיל הנוכחי:",
  profileSaved: "הפרופיל נשמר.",
  profileInvalid: (err: string) => `הפרופיל לא נשמר:\n${err}`,
  setProfileUsage: "שלח /setprofile ובשורות הבאות את הפרופיל המלא ב-YAML.",
  cvAsk: "שלח לי את קורות החיים כקובץ PDF (אפשר כמה גרסאות, קובץ אחר קובץ).",
  cvNotPdf: "אני מקבל רק קבצי PDF.",
  cvTooBig: "הקובץ גדול מדי (עד 10MB).",
  cvParsing: "קורא את קורות החיים…",
  cvParsed: (summary: string) => `זה מה שהבנתי מקורות החיים:\n\n${summary}\n\nלשמור?`,
  cvSaved: "קורות החיים נשמרו. מעכשיו ההתאמות יתבססו עליהם.",
  cvDiscarded: "בוטל. קורות החיים הקודמים נשארו.",
  cvNothingPending: "אין קורות חיים שממתינים לאישור.",
  cvFailed: (err: string) => `לא הצלחתי לקרוא את הקובץ: ${err}`,
  btnSave: "💾 שמור",
  btnDiscard: "✖️ בטל",

  cardScore: (score: number) => `ציון התאמה: ${score}/100`,
  cardWhy: "למה זה מתאים:",
  cardConcerns: "שים לב:",
  cardMessage: "הודעה מוצעת:",
  cardApplyEmail: (to: string) => `הגשה במייל אל ${to}`,
  cardApplyLink: (url: string) => `הגשה דרך קישור (ידנית): ${url}`,
  cardApplyPhone: (phone: string) => `יצירת קשר בטלפון (ידנית): ${phone}`,
  cardApplyUnknown: "לא נמצאה דרך הגשה במודעה.",
  cardSource: (group: string) => `מקור: ${group}`,
  cardSalaryUnknown: "שכר לא צוין",
  cardCvVariant: (v: string) => `גרסת קו״ח: ${v}`,
  cvNotTailored: "קורות החיים לא הותאמו למשרה (תצורף הגרסה המקורית)",
  btnApply: "✅ הגש",
  btnEdit: "✏️ ערוך הודעה",
  btnSkip: "⏭ דלג",
  btnAppliedManually: "✅ הגשתי בעצמי",

  applyQueued: "בתור לשליחה. אעדכן כשנשלח.",
  applySent: (to: string) => `נשלח אל ${to} ✅`,
  applyFailed: (err: string) => `השליחה נכשלה: ${err}`,
  applyNotReady: "המשרה הזאת כבר טופלה.",
  applyNoEmail: "אין כתובת מייל במודעה, צריך להגיש ידנית.",
  applyNoSmtp: "פרטי SMTP לא הוגדרו, אי אפשר לשלוח מייל.",
  markedManual: "סימנתי שהגשת. בהצלחה!",
  editAsk: "שלח את ההודעה החדשה (הטקסט שיישלח עם קורות החיים).",
  editSaved: "ההודעה עודכנה. הנה הכרטיס המעודכן:",
  skipAsk: "למה לדלג? זה עוזר לי ללמוד מה מתאים לך.",
  skipFreeTextAsk: "כתוב בקצרה למה המשרה לא מתאימה.",
  skipped: "דילגתי. תודה, אלמד מזה.",
  skipReasons: {
    salary: "שכר",
    location: "מיקום",
    role: "תפקיד לא רלוונטי",
    seniority: "בכירות",
    company: "החברה",
    scope: "היקף משרה",
    other: "סיבה אחרת…",
    none: "בלי סיבה",
  },
  jobNotFound: "המשרה לא נמצאה.",

  status: (s: {
    paused: boolean;
    waConnected: boolean;
    lastMessageAgo: string;
    lastRunAgo: string;
    groups: number;
    hasCv: boolean;
    today: string;
  }) =>
    [
      s.paused ? "⏸ מושהה" : "▶️ פעיל",
      `וואטסאפ: ${s.waConnected ? "מחובר" : "מנותק"}`,
      `הודעה אחרונה מהקבוצות: ${s.lastMessageAgo}`,
      `סריקה אחרונה: ${s.lastRunAgo}`,
      `קבוצות בסריקה: ${s.groups}`,
      `קורות חיים: ${s.hasCv ? "קיימים" : "חסרים, שלח /cv"}`,
      `היום: ${s.today}`,
    ].join("\n"),
  never: "אף פעם",
  ago: (minutes: number) =>
    minutes < 60
      ? `לפני ${minutes} דק׳`
      : minutes < 48 * 60
        ? `לפני ${Math.round(minutes / 60)} שע׳`
        : `לפני ${Math.round(minutes / 1440)} ימים`,

  waPairingCode: (code: string) =>
    `קוד קישור לוואטסאפ: ${code}\nבטלפון: הגדרות ← מכשירים מקושרים ← קישור מכשיר ← קישור עם מספר טלפון.`,
  waConnected: "וואטסאפ מחובר ✅",
  waLoggedOut: "וואטסאפ התנתק (המכשיר הוסר). שלח /status ואעביר קוד קישור חדש בהפעלה הבאה.",
  runSummary: (found: number, cards: number) =>
    `סריקה הסתיימה: ${found} משרות חדשות, ${cards} מתאימות.`,
  noCvWarning: "יש משרות מתאימות אבל עוד אין קורות חיים. שלח /cv.",
  digest: (counts: string) => `סיכום יומי (24 שעות):\n${counts}`,
  noActivity: "אין פעילות",
  statusLabels: {
    new: "ממתינות לעיבוד",
    duplicate: "כפולות",
    filtered: "סוננו",
    low_score: "התאמה נמוכה",
    ready: "ממתינות לאישורך",
    applying: "בתור לשליחה",
    applied: "הוגשו",
    manual: "הוגשו ידנית",
    skipped: "דולגו",
    failed: "נכשלו",
  } as Record<string, string>,
  healthAlert: (problem: string) => `⚠️ ${problem}`,
  alertNoMessages: (hours: number) =>
    `לא הגיעו הודעות מהקבוצות כבר ${hours} שעות. ייתכן שהוואטסאפ תקוע.`,
  alertWaDown: (minutes: number) => `הוואטסאפ מנותק כבר ${minutes} דקות.`,
  alertRunFailed: (err: string) => `הסריקה נכשלה: ${err}`,
};
