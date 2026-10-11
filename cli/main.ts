import { readFile } from "node:fs/promises";
import path from "node:path";
import { YamakanClient, YamakanError } from "../sdk/client.ts";
import type { Operation } from "../sdk/client.ts";
const [name, args = "{}"] = process.argv.slice(2);
if (!name) throw new Error("Usage: npm run cli -- yamakan.project.list {}");
const env = (key: string) =>
  process.env[`YAMAKAN_${key}`] || process.env[`DARZAIN_${key}`];
const url = env("URL") || "http://127.0.0.1:4318";
if (new URL(url).hostname !== "127.0.0.1")
  throw new Error("CLI connects only to the local Yamakan server.");
const root = path.resolve(env("WORKSPACE") || ".yamakan");
const token = (await readFile(path.join(root, "token"), "utf8")).trim();
const client = new YamakanClient({ baseUrl: url, token });
try {
  const result =
    name === "tools"
      ? await client.catalog()
      : await client.call(name as Operation, JSON.parse(args));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (!(e instanceof YamakanError)) throw e;
  console.error(JSON.stringify({ code: e.code, message: e.message }));
  process.exitCode = 1;
}
