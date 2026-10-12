// Interface language (plan T8: localized UI; contract: "UI strings/layout
// use RTL separately from title shaping"). Yamakan's own interface strings
// in English and Arabic. Arabic switches the page to right-to-left; the
// timeline keeps left-to-right time. Title text is shaped by libass at
// render time and is unaffected by the interface language.

export type Lang = "en" | "ar";

const en = {
  "lang.label": "Language",
  "lang.switch": "العربية",
  "brand.tagline": "Creative production · Offline workspace",
  "nav.production": "Production",
  "nav.tools": "Agent tools",
  "badge.local": "Local media · CPU rendering",
  "status.initial": "Create or open a project to begin.",
  "status.working": "Working…",
  "status.opened": "Opened {name}, revision {revision}.",
  "status.saved": "Saved revision {revision}.",
  "error.operation": "Operation failed.",
  "error.edit": "Invalid edit.",
  "error.assetMissing": "Asset missing.",
  "error.track": "Choose an unlocked compatible track.",
  "projects.title": "Projects",
  "projects.name": "Project name",
  "projects.defaultName": "Untitled production",
  "projects.create": "Create project",
  "projects.revision": "Revision {revision}",
  "projects.history": "History & recovery",
  "assets.title": "Assets",
  "assets.import": "Import local media",
  "assets.kind.image": "image",
  "assets.kind.video": "video",
  "assets.kind.audio": "audio",
  "assets.size": "{kb} KB",
  "import.failed": "Import failed.",
  "import.converting":
    "Converting {name} to a constant frame rate before editing…",
  "import.stillConverting":
    "{name} is still converting; it will appear in the asset list when it finishes.",
  "import.incomplete": "Conversion did not complete.",
  "import.converted":
    "Imported {name} at a constant frame rate. Click it to add it to the timeline.",
  "import.done": "Imported {name}. Click it to add it to the timeline.",
  "hint.media":
    "Media stays on this computer. Imported video sound is not mixed automatically; add a separate audio asset. No inference backend is enabled yet.",
  "history.label": "Project history",
  "history.title": "Project history & recovery",
  "history.current": "Project {id} · Current revision {revision}",
  "history.unverified": "unverified",
  "history.note":
    "Restoring creates a new revision. Existing snapshots and the previous head are preserved.",
  "history.unverifiable":
    "The current project cannot be verified. Choose a verified snapshot to recover it.",
  "history.item": "Revision {revision} · {name}",
  "history.restore": "Restore revision {revision}",
  "history.saveFirst":
    "Save your edits or download an unsaved draft before restoring. Draft JSON retains edits; media stays in this workspace.",
  "history.downloadDraft": "Download unsaved draft",
  "history.close": "Close history",
  "tools.title": "Yamakan agent tools",
  "tools.intro":
    "The same validated project and render operations power the editor and local REST API.",
  "tools.catalog": "Open the versioned tool catalog",
  "tools.jobs":
    "Jobs expose progress, cancellation, errors and verified video artifacts. Project paths and arbitrary commands are not accepted by the API.",
  "toolbar.unsaved": "Unsaved changes",
  "action.undo": "Undo",
  "action.redo": "Redo",
  "action.save": "Save",
  "action.export": "Export video",
  "transport.play": "Play",
  "transport.pause": "Pause",
  "transport.playhead": "Playhead",
  "transport.seconds": "{seconds} s",
  "scene.heading": "Scene & shot",
  "scene.add": "Add scene",
  "scene.default": "Scene {n}",
  "scene.name": "Scene name",
  "scene.focal": "Focal length (mm)",
  "scene.scale": "Shot scale",
  "scene.movement": "Movement",
  "scene.scale.wide": "wide",
  "scene.scale.medium": "medium",
  "scene.scale.close": "close",
  "scene.movement.static": "static",
  "scene.movement.dolly": "dolly",
  "scene.movement.pan": "pan",
  "scene.movement.orbit": "orbit",
  "hint.camera":
    "Camera settings record shot intent. They do not change imported footage.",
  "title.heading": "Title",
  "title.text": "Title text",
  "title.add": "Add title",
  "track.titles": "Titles",
  "track.picture": "Picture",
  "track.audio": "Audio",
  "job.QUEUED": "Export queued",
  "job.RUNNING": "Export running",
  "job.COMPLETED": "Export completed",
  "job.FAILED": "Export failed",
  "job.CANCELLED": "Export cancelled",
  "job.cancel": "Cancel export",
  "job.download": "Download MP4",
  "empty.title": "Your next production starts here.",
  "empty.body":
    "Create a local project, import media, plan a shot, edit the timeline and export a playable video.",
  "empty.persist":
    "Projects remain editable after closing and reopening Yamakan.",
  footer: "Yamakan engineering preview · Offline workflows",
  "reference.region": "Reference preview",
  "reference.title": "Reference preview",
  "reference.empty": "Add a clip or title to see the reference preview.",
  "reference.state": "Saved revision {revision}, frame {frame}",
  "reference.stale": "Stale: save to include your latest edits",
  "reference.save": "Save and refresh",
  "reference.play": "Play reference (2 s)",
  "reference.segment": "Reference segment",
  "reference.alt": "Reference frame {frame} of saved revision {revision}",
  "reference.rendering": "Rendering…",
  "reference.failed":
    "The reference preview could not be rendered for this revision.",
} as const;

export type MessageKey = keyof typeof en;

const ar: Record<MessageKey, string> = {
  "lang.label": "اللغة",
  "lang.switch": "English",
  "brand.tagline": "إنتاج إبداعي · مساحة عمل دون اتصال",
  "nav.production": "الإنتاج",
  "nav.tools": "أدوات الوكلاء",
  "badge.local": "وسائط محلية · عرض بالمعالج",
  "status.initial": "أنشئ مشروعًا أو افتح مشروعًا للبدء.",
  "status.working": "جارٍ العمل…",
  "status.opened": "فُتح {name}، المراجعة {revision}.",
  "status.saved": "حُفظت المراجعة {revision}.",
  "error.operation": "تعذّر إتمام العملية.",
  "error.edit": "تعديل غير صالح.",
  "error.assetMissing": "الوسيط غير موجود.",
  "error.track": "اختر مسارًا متوافقًا غير مقفل.",
  "projects.title": "المشاريع",
  "projects.name": "اسم المشروع",
  "projects.defaultName": "إنتاج بلا عنوان",
  "projects.create": "إنشاء مشروع",
  "projects.revision": "المراجعة {revision}",
  "projects.history": "السجل والاستعادة",
  "assets.title": "الوسائط",
  "assets.import": "استيراد وسائط محلية",
  "assets.kind.image": "صورة",
  "assets.kind.video": "فيديو",
  "assets.kind.audio": "صوت",
  "assets.size": "{kb} ك.ب",
  "import.failed": "تعذّر الاستيراد.",
  "import.converting": "جارٍ تحويل {name} إلى معدل إطارات ثابت قبل التحرير…",
  "import.stillConverting":
    "لا يزال تحويل {name} جاريًا، وسيظهر في قائمة الوسائط عند اكتماله.",
  "import.incomplete": "لم يكتمل التحويل.",
  "import.converted":
    "استُورد {name} بمعدل إطارات ثابت. انقر عليه لإضافته إلى الخط الزمني.",
  "import.done": "استُورد {name}. انقر عليه لإضافته إلى الخط الزمني.",
  "hint.media":
    "تبقى الوسائط على هذا الحاسوب. لا يُمزج صوت الفيديو المستورد تلقائيًا؛ أضف وسيطًا صوتيًا منفصلًا. لم تُفعَّل أي خدمة استدلال بعد.",
  "history.label": "سجل المشروع",
  "history.title": "سجل المشروع والاستعادة",
  "history.current": "المشروع {id} · المراجعة الحالية {revision}",
  "history.unverified": "غير متحقَّق منها",
  "history.note":
    "تُنشئ الاستعادة مراجعة جديدة، وتُحفظ اللقطات الحالية والمراجعة السابقة كما هي.",
  "history.unverifiable":
    "تعذّر التحقق من المشروع الحالي. اختر لقطة متحقَّقًا منها لاستعادته.",
  "history.item": "المراجعة {revision} · {name}",
  "history.restore": "استعادة المراجعة {revision}",
  "history.saveFirst":
    "احفظ تعديلاتك أو نزّل مسودة غير محفوظة قبل الاستعادة. تحتفظ مسودة JSON بالتعديلات، وتبقى الوسائط في مساحة العمل هذه.",
  "history.downloadDraft": "تنزيل المسودة غير المحفوظة",
  "history.close": "إغلاق السجل",
  "tools.title": "أدوات الوكلاء في يماكن",
  "tools.intro":
    "تعتمد المحرِّر وواجهة REST المحلية على عمليات المشروع والعرض نفسها التي جرى التحقق منها.",
  "tools.catalog": "فتح دليل الأدوات ذي الإصدارات",
  "tools.jobs":
    "تعرض المهام التقدم والإلغاء والأخطاء وملفات الفيديو المتحقَّق منها. لا تقبل الواجهة مسارات المشاريع ولا الأوامر العشوائية.",
  "toolbar.unsaved": "تغييرات غير محفوظة",
  "action.undo": "تراجع",
  "action.redo": "إعادة",
  "action.save": "حفظ",
  "action.export": "تصدير الفيديو",
  "transport.play": "تشغيل",
  "transport.pause": "إيقاف مؤقت",
  "transport.playhead": "موضع التشغيل",
  "transport.seconds": "{seconds} ث",
  "scene.heading": "المشهد واللقطة",
  "scene.add": "إضافة مشهد",
  "scene.default": "المشهد {n}",
  "scene.name": "اسم المشهد",
  "scene.focal": "البعد البؤري (مم)",
  "scene.scale": "حجم اللقطة",
  "scene.movement": "الحركة",
  "scene.scale.wide": "واسعة",
  "scene.scale.medium": "متوسطة",
  "scene.scale.close": "قريبة",
  "scene.movement.static": "ثابتة",
  "scene.movement.dolly": "دولي",
  "scene.movement.pan": "استدارة أفقية",
  "scene.movement.orbit": "دوران حول الموضوع",
  "hint.camera":
    "تسجّل إعدادات الكاميرا نية اللقطة فقط، ولا تغيّر اللقطات المستوردة.",
  "title.heading": "العنوان",
  "title.text": "نص العنوان",
  "title.add": "إضافة عنوان",
  "track.titles": "العناوين",
  "track.picture": "الصورة",
  "track.audio": "الصوت",
  "job.QUEUED": "التصدير في الانتظار",
  "job.RUNNING": "التصدير جارٍ",
  "job.COMPLETED": "اكتمل التصدير",
  "job.FAILED": "فشل التصدير",
  "job.CANCELLED": "أُلغي التصدير",
  "job.cancel": "إلغاء التصدير",
  "job.download": "تنزيل MP4",
  "empty.title": "إنتاجك القادم يبدأ من هنا.",
  "empty.body":
    "أنشئ مشروعًا محليًا، واستورد الوسائط، وخطّط للقطة، وحرّر الخط الزمني، وصدّر فيديو قابلًا للتشغيل.",
  "empty.persist": "تبقى المشاريع قابلة للتحرير بعد إغلاق يماكن وإعادة فتحه.",
  footer: "معاينة هندسية من يماكن · سير عمل دون اتصال",
  "reference.region": "المعاينة المرجعية",
  "reference.title": "المعاينة المرجعية",
  "reference.empty": "أضف مقطعًا أو عنوانًا لرؤية المعاينة المرجعية.",
  "reference.state": "المراجعة المحفوظة {revision}، الإطار {frame}",
  "reference.stale": "غير محدّثة: احفظ لتضمين أحدث تعديلاتك",
  "reference.save": "حفظ وتحديث",
  "reference.play": "تشغيل المرجع (ثانيتان)",
  "reference.segment": "مقطع مرجعي",
  "reference.alt": "الإطار المرجعي {frame} من المراجعة المحفوظة {revision}",
  "reference.rendering": "جارٍ العرض…",
  "reference.failed": "تعذّر عرض المعاينة المرجعية لهذه المراجعة.",
};

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, ar };

// The placeholders a message uses, e.g. ["name", "revision"].
export const placeholders = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

// Numbers in the interface language's digits (Arabic-Indic for Arabic).
export function formatNumber(lang: Lang, value: number) {
  // Arabic-Indic digits are requested explicitly: the CLDR default for
  // "ar" varies by data version and region.
  return new Intl.NumberFormat(lang === "ar" ? "ar-u-nu-arab" : "en").format(
    value,
  );
}

// A message with its placeholders filled. Numbers are written in the
// language's digits; other values are inserted as given.
export function translate(
  lang: Lang,
  key: MessageKey,
  vars: Record<string, string | number> = {},
) {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? formatNumber(lang, value) : value;
  });
}

export const direction = (lang: Lang) => (lang === "ar" ? "rtl" : "ltr");

// The saved choice, else the browser's preference. Storage can be absent or
// blocked; the interface then follows the browser.
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem("yamakan.lang");
    if (saved === "en" || saved === "ar") return saved;
  } catch {}
  return typeof navigator !== "undefined" &&
    navigator.language?.toLowerCase().startsWith("ar")
    ? "ar"
    : "en";
}

export function saveLang(lang: Lang) {
  try {
    localStorage.setItem("yamakan.lang", lang);
  } catch {}
}
