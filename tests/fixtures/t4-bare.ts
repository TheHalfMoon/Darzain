// A script with no server: owner.run() must settle and the script must exit.
import { fileURLToPath } from "node:url";
const workerProbe = fileURLToPath(
  new URL(
    "../../native/procd/target/release/worker-probe.exe",
    import.meta.url,
  ),
);
import { ProcessOwner } from "../../core/process/owner.ts";

const owner = new ProcessOwner([workerProbe]);
for (let i = 0; i < 20; i++) {
  const { code } = await owner.run({
    executable: workerProbe,
    args: ["print", "x"],
    cwd: process.cwd(),
  });
  if (code !== 0) process.exit(2);
}
process.stdout.write("done");
