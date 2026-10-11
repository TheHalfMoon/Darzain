import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const quiet = process.argv[2] === "quiet";
// render.ts style: -progress pipe:1 writes stdout periodically; "quiet" variant writes nothing.
const args = ["-hide_banner","-nostdin","-y", ...(quiet?["-v","quiet"]:[]),"-f","lavfi","-i","testsrc2=s=1280x720:r=30:d=600","-c:v","libx264","-preset","veryfast","-threads","1", ...(quiet?[]:["-progress","pipe:1"]),"-f","null","-"];
const c = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore","pipe","pipe"] });
c.stdout.on("data", () => {}); c.stderr.on("data", () => {});
writeFileSync(process.argv[3], JSON.stringify({ node: process.pid, ffmpeg: c.pid }));
setInterval(() => {}, 1000);
