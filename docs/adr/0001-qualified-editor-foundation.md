# ADR 0001: Qualified filmmaker editor boundary

Date: 2026-10-11. Status: accepted for the engineering preview, subject to behavioral qualification.

## Decision

Adopt bounded Timeline, PreviewPlayer and supporting editor modules from AI Video Production Editor rather than its complete Electron/cloud application. Maintain one strict Darzain project model and a loopback media/agent service. Adapt the existing FFmpeg timeline algorithm with explicit audio and validated output. Use Ninerr canonical serialization directly. Qualify ArtCraft composition and Open Generative AI workers as later isolated integrations.

## Evidence

The filmmaker web build succeeds and 145 tests pass. Its editor source is substantial, while its 418KB application coordinator brings many unrelated providers and production flows. Electron source disables web security and its HQ export ignores audio tracks. ArtCraft frontend and Open Generative AI Vite builds also pass, but neither establishes a fully qualified standalone Darzain filmmaking workflow. Current OpenCut's Rust timeline panel is a placeholder; classic has substantial editing code but its Bun build was not qualified here. Bounded REA graphs support extraction questions but do not establish runtime safety.

## Consequences

Darzain gains a real editor and preview immediately without a second canonical project state. Custom code is confined to schema, trust, persistence and process boundaries where source integration needs adaptation. Preview/export parity, durable ownership, advanced editing and actual scene/generation behavior remain acceptance work. Licensing follows the GPL combined application with preserved Apache notices. This decision does not claim the discarded donor shell is safe or that the larger competitive vision is complete.
