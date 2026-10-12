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
  {
    // A line that opens with digits and punctuation, in an Arabic paragraph.
    name: "leading-digits",
    text: "١٢: «البداية» — 3.5 ثانية",
  },
  {
    // Characters that are ASS syntax, shown literally.
    name: "literal-syntax",
    text: "النص {\\b1} و \\N و \\h و {} يظهر كما هو",
  },
  {
    name: "tatweel-and-signs",
    text: "مـــرحبـــا — ٥٠٪ — ٣٫١٤ — ٢٬٥٠٠",
  },
  {
    name: "latin-only",
    text: "Final cut: Scene 4, take 12 (approved).",
  },
] as const;

// Clipping: libass cannot wrap a run without spaces, so one wider than the
// frame must be refused before rendering, never cut off.
export const OVERLONG_TITLE =
  "كلمةطويلةجدابدونمسافاتتختبرالقصعندحافةالإطارولاينبغيأنتختفي".repeat(2);
