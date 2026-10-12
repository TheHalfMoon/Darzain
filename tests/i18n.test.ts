import test from "node:test";
import assert from "node:assert/strict";
import {
  MESSAGES,
  direction,
  formatNumber,
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
    "Opened Film, revision 12.",
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
