import { execFileSync } from "node:child_process";
execFileSync("ffmpeg", ["-hide_banner","-v","error","-y","-f","lavfi","-i","color=c=black:s=900x300","-vf","subtitles=titles.ass","-frames:v","1","libass-auto.png"], { cwd: "t4" });
console.log("ok");
