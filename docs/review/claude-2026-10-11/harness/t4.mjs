import { execFileSync } from "node:child_process";
import { copyFileSync, writeFileSync, mkdirSync } from "node:fs";
mkdirSync("t4", { recursive: true });
copyFileSync(`${process.env.WINDIR}/Fonts/arial.ttf`, "t4/font.ttf");
writeFileSync("t4/ar.txt", "يمكان: فيلم قصير ٢٠٢٦ — Yamakan");
for (const s of [1, 0]) {
  execFileSync("ffmpeg", ["-hide_banner","-v","error","-y","-f","lavfi","-i","color=c=black:s=900x140",
    "-vf", `drawtext=fontfile='font.ttf':textfile='ar.txt':expansion=none:text_shaping=${s}:fontsize=52:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
    "-frames:v","1",`shaping${s}.png`], { cwd: "t4" });
}
// Default (no text_shaping option) is exactly what render.ts emits:
execFileSync("ffmpeg", ["-hide_banner","-v","error","-y","-f","lavfi","-i","color=c=black:s=900x140",
  "-vf", `drawtext=fontfile='font.ttf':textfile='ar.txt':expansion=none:fontsize=52:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
  "-frames:v","1","render-default.png"], { cwd: "t4" });
console.log("ok");
