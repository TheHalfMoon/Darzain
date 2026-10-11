# Local inference and hardware

Final proposal: [master plan](IMPLEMENTATION_PLAN.md) and [operational contracts](OPERATIONAL_CONTRACTS.md) own current scope and exact protocols. Earlier evidence remains bounded; no final implementation or founder approval is implied.

Observed host: Windows, Intel i5-13420H with 12 logical CPUs, about 16 GiB RAM; CIM exposes Intel UHD Graphics AdapterRAM 1 GiB. No compatible discrete GPU verified. Existing Ollama CPU-resident Qwen3 4B models establish LLM availability, not image/video qualification. Node 24.19.0/FFmpeg 8.1.1 support the existing offline slice; Python 3.14.7 is the research interpreter, not universal inference compatibility.

Offline editing/render/export must launch without GPU/Python/weights/cloud. Optional worker environments are separately pinned with user-approved model downloads, sizes, exact model/license IDs and hardware limits. Probe runtime/backend, free memory, drivers/model hashes and actual workload. Shared graphics memory is not dedicated VRAM; missing nvidia-smi alone does not prove no GPU.

| Candidate | Observed boundary | Qualification here |
|---|---|---|
| ComfyUI | Specific graph/nodes/models and backend required | Source only, no inference |
| Wan2GP | Some documented 6 GB profiles; CUDA/AMD vary | No compatible profile tested |
| FramePack | NVIDIA and at least 6 GB documented | Not qualified |
| TRELLIS | Linux/NVIDIA 16 GB baseline | Not qualified |
| LTX/Hunyuan/Wan-Move/FLUX | Exact CUDA/offload/quantization/model rights required | Not qualified |
| faster-whisper | CPU/int8 candidate, CTranslate2/PyAV wheels | No output/Arabic benchmark |
| ESRGAN/RIFE/GroundingDINO | CPU paths exist, compatibility/latency unknown | No output benchmark |
| Piper | Maintained local TTS source found | Voice weights/Arabic quality unknown |

First AI qualification should use one existing supported user-owned ComfyUI backend or an explicitly consented user-controlled inference host. Direct BYOK can be qualified independently without pretending this laptop supports cinematic diffusion. No paid run or weight download occurred during planning.

Supervisor owns processes, concurrency, CPU/GPU/disk budgets and cancellation. Shared ComfyUI global interrupt requires exclusive ownership or a documented limitation. No automatic custom-node installation. Project archives cannot supply trusted executable configs/pickle checkpoints. Inference failures cannot disable offline editing.

## Execution profiles (independent review, 2026-10-11)

| Profile | Scope | Proposed minimum | Gate |
|---|---|---|---|
| A — Offline CPU | Whole MVP: edit, preview, FFmpeg export, optional CPU transcription later | 4 cores, 8 GiB RAM, local NTFS, Windows 10 22H2+; disk for inputs + derivatives + output + measured reserve | First-slice DoD on a clean host with the network disabled |
| B — Local AI (optional) | ComfyUI or a pinned worker environment per operation | NVIDIA with ≥ 12 GB VRAM (video) or ≥ 8 GB (image), 32 GB RAM, ≥ 60 GB free | Per-operation receipt on that hardware (model/weights hash and license, input/output hashes, latency, memory, cancel and recovery). Disabled otherwise |
| C — BYOK cloud | User's own provider keys | Network, per-upload consent, budget | Founder-approved capped real test; never required for A |

The host hardware is a Profile A candidate only; its limited free disk does not qualify a large-media fixture. The earlier 3.4 GB value is historical; final preflight observed about 2.9 GiB. Every run must record current disk and refuse below its dynamic input/derivative/output/reserve need.

On Windows, even direct MVP FFmpeg/ffprobe needs the service-owned atomic Job Object launch contract in OPERATIONAL_CONTRACTS. The small native binding belongs in T4 for probes and is reused in T5 for render jobs, without a desktop dependency. Descendant workers additionally require their tree tests. A surviving desktop-host handle alone does not handle service death. Launch by absolute executable/interpreter path, never through WindowsApps aliases. Review T3 showed that the FFmpeg grandchild of a Python worker survives a hard kill of the Node service, and that alias launchers escape entirely. ComfyUI supports targeted `prompt_id` interruption at the pinned commit, but its check-then-interrupt is not atomic, so prefer an exclusive Yamakan-owned ComfyUI instance.
