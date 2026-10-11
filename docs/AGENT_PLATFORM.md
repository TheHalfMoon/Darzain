# Agent platform

The browser and CLI share CreativeAPI. GET /api/v1/tools returns apiVersion=1 with strict JSON schemas. POST /api/v1/call accepts only name and arguments. Supported tools: project.create, project.open, project.list, project.save, export.video, job.status, job.cancel and job.list, each prefixed darzain.

Media import uses POST /api/v1/projects/{projectId}/assets with raw bytes and URL-encoded X-Asset-Name. Assets are probed, hashed and registered through the same trusted path. Client-supplied filesystem paths, executable names and arbitrary commands are not tools.

The loopback service checks Host and Origin, rejects cross-site requests, and requires a private bearer token or HttpOnly SameSite cookie. The CLI uses .darzain/token or the configured workspace. Process restart rotates credentials. Human/agent provenance and per-project permissions are planned; the current service trusts the local account.

Exports return job identifiers, revision, progress, terminal error and artifact path. Same project/revision/idempotency key returns the same session job. The registry is memory-only today; durable restart semantics belong to P02. Add granular scene/clip/track tools and an MCP transport in P04 using this same API rather than introducing another mutation path.

Project recovery is available through darzain.project.history and darzain.project.restore. History returns verified candidates plus a SHA-256 fingerprint of the current raw head (null when absent). Restore requires projectId, revision and expectedHeadFingerprint, rejects stale fingerprints, validates media, and returns a new canonical project revision. The browser uses these same authenticated tools.
