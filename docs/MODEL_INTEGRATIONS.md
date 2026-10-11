# Model integrations

No model is enabled in the current application. There is no mock generation or model dropdown. No weights were downloaded and no inference run is claimed.

First candidate: an existing locally operated ComfyUI backend. Source inspection covered /prompt, /queue, /history, /object_info and interrupt handling. Per-job cancellation cannot be assumed from a global interrupt endpoint; an adapter must preserve shared backend safety. Worker identity/version, node capabilities, model presence, VRAM/disk budgets and actual output media must be checked.

Wan2GP is the next worker candidate; Open Generative AI's Electron localAI layer exposes existing sd.cpp/Wan2GP integrations but is not itself a standalone inference engine. Qualify its subprocess and job boundaries before reuse. InvokeAI remains an optional image-canvas candidate.

LTX-2, HunyuanVideo-1.5, FramePack, Diffusers, FLUX, motion control, lip sync, segmentation and 3D model sources remain unqualified. Code license, weights license, downloads and resource needs need separate receipts. CPU/GPU limitations must disable unsupported controls with an actionable reason. Remote provider keys, when explicitly configured, belong in private server-side storage.
