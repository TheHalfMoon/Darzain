import { readFile } from "node:fs/promises";
import path from "node:path";
const [name, args = "{}"] = process.argv.slice(2);
if (!name) throw new Error("Usage: npm run cli -- darzain.project.list {}");
const url = process.env.DARZAIN_URL || "http://127.0.0.1:4318";
if (new URL(url).hostname !== "127.0.0.1")
  throw new Error("CLI connects only to the local Darzain server.");
const root = process.env.DARZAIN_WORKSPACE || path.resolve(".darzain");
const token = (await readFile(path.join(root, "token"), "utf8")).trim();
const response = await fetch(`${url}/api/v1/call`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ name, arguments: JSON.parse(args) }),
});
const result = await response.json();
if (!response.ok) {
  console.error(result);
  process.exitCode = 1;
} else console.log(JSON.stringify(result, null, 2));
