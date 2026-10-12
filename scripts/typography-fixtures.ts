// Arabic/Latin title fixtures (contract: punctuation, bidi isolates,
// diacritics, Arabic-Indic digits, lam-alef, mixed lines, line wraps and
// clipping, which is refused rather than cut off). Shared by tests/typography.test.ts and
// scripts/qualify-typography.ts, which renders them for human review.
export const TYPOGRAPHY_FIXTURES = [
  {
    name: "punctuation",
    text: "مرحبًا، كيف حالك؟ «اقتباس» — نعم! (أقواس) ؛ نقطة.",
  },
  {
    name: "bidi-isolates",
    text: "الإصدار \u2068Yamakan 2.0\u2069 جاهز، والملف \u2066report-final.mp4\u2069 محفوظ.",
  },
  {
    name: "diacritics",
    text: "بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ — شَدَّة وتَنْوِينٌ وسُكُون.",
  },
  {
    name: "arabic-indic-digits",
    text: "المشهد ١٢ اللقطة ٣٤٥ — ٢٠٢٦/١٠/١٢ — ۱۲۳ — 42%",
  },
  {
    name: "lam-alef",
    text: "لا لأ لإ لآ — سلام، الأمل، الإنتاج، لآلئ.",
  },
  {
    name: "mixed-lines",
    text: "Opening scene: الفصل الأول\nالفصل الأول: Opening scene",
  },
  {
    name: "line-wrap",
    text: "هذا عنوان طويل جدًا يجب أن يلتف تلقائيًا على عدة أسطر داخل إطار الفيديو دون أن يخرج عن حدوده أو يتداخل مع الحواف.",
  },
  {
    // A long unbreakable run that still fits the frame.
    name: "long-word",
    text: "كلمةطويلةجدابدونمسافاتتختبرالقصعندحافةالإطارولاينبغيأنتختفي",
  },
] as const;

// Clipping: libass cannot wrap a run without spaces, so one wider than the
// frame must be refused before rendering, never cut off.
export const OVERLONG_TITLE =
  "كلمةطويلةجدابدونمسافاتتختبرالقصعندحافةالإطارولاينبغيأنتختفي".repeat(2);
