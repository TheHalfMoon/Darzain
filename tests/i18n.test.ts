import test from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGES,
  direction,
  formatNumber,
  formatPercent,
  formatSeconds,
  placeholders,
  translate,
} from "../src/i18n.ts";

test("every interface message exists in English and Arabic with the same placeholders", () => {
  const keys = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.ar).sort(), keys);
  for (const key of keys) {
    const en = MESSAGES.en[key as keyof typeof MESSAGES.en];
    const ar = MESSAGES.ar[key as keyof typeof MESSAGES.ar];
    assert.ok(en.trim() && ar.trim(), `${key} is empty`);
    assert.deepEqual(placeholders(ar), placeholders(en), key);
  }
});

test("Arabic messages are written in Arabic (apart from names and formats)", () => {
  // The language switch names the other language; MP4 and JSON are format
  // names.
  for (const [key, value] of Object.entries(MESSAGES.ar))
    if (key !== "lang.switch")
      assert.match(value, /[\u0600-\u06ff]/, `${key}: ${value}`);
  assert.equal(MESSAGES.ar["lang.switch"], "English");
  assert.match(MESSAGES.en["lang.switch"], /[\u0600-\u06ff]/);
});

test("placeholders are filled, numbers use the language's digits, and Arabic is right to left", () => {
  assert.equal(
    translate("en", "status.opened", { name: "Film", revision: 12 }),
    `Opened ${String.fromCharCode(0x2068)}Film${String.fromCharCode(0x2069)}, revision 12.`,
  );
  assert.equal(
    translate("ar", "projects.revision", { revision: 12 }),
    "المراجعة ١٢",
  );
  assert.equal(formatNumber("ar", 2026), "٢٬٠٢٦");
  assert.equal(formatNumber("en", 2026), "2,026");
  // A missing value leaves the placeholder visible rather than inventing one.
  assert.equal(translate("en", "status.saved"), "Saved revision {revision}.");
  assert.equal(direction("ar"), "rtl");
  assert.equal(direction("en"), "ltr");
});

test("inserted names are isolated so they cannot reorder the sentence; unknown keys fall back", () => {
  const FSI = String.fromCharCode(0x2068);
  const PDI = String.fromCharCode(0x2069);
  const opened = translate("ar", "status.opened", {
    name: "Film (v2)!",
    revision: 3,
  });
  assert.ok(opened.includes(`${FSI}Film (v2)!${PDI}`), opened);
  assert.ok(
    opened.includes("٣"),
    "numbers are not isolated, and use Arabic digits",
  );
  // A name carrying a right-to-left override stays inside its isolate.
  const spoof = translate("en", "import.done", {
    name: `clip${String.fromCharCode(0x202e)}gnp.mp4`,
  });
  assert.ok(
    spoof.startsWith(`Imported ${FSI}clip`) && spoof.includes(`mp4${PDI}.`),
  );
  // Its own pop or override characters are removed, so it cannot close the
  // isolate early.
  const escape = translate("en", "import.done", {
    name: `a${PDI}${String.fromCharCode(0x202e)}b`,
  });
  assert.ok(escape.startsWith(`Imported ${FSI}ab${PDI}.`), escape);
  // A state the service adds later does not crash the interface.
  assert.equal(translate("ar", "job.PAUSED" as never), "job.PAUSED");
});

test("durations keep two decimals and percentages use the language's sign", () => {
  assert.equal(formatSeconds("en", 1.5), "1.50");
  assert.equal(formatSeconds("en", 1234.5), "1234.50", "no grouping");
  assert.equal(formatSeconds("ar", 1.5), "١٫٥٠");
  assert.equal(formatPercent("en", 0.5), "50%");
  // ICU adds an Arabic letter mark after the sign for correct direction.
  assert.ok(formatPercent("ar", 0.5).startsWith("٥٠٪"));
});

test("interface source writes direction controls as escapes, never as raw characters", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = new URL("../src/", import.meta.url);
  const raw = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
  for (const name of await readdir(dir))
    if (/\.(ts|tsx)$/.test(name))
      assert.doesNotMatch(
        await readFile(new URL(name, dir), "utf8"),
        raw,
        name,
      );
});
