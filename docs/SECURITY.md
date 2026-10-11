# Security boundary

The preview runs on 127.0.0.1 under a trusted local account. It rejects unexpected Host/Origin and cross-site fetches, authenticates API access, limits bodies, uses strict schemas and disallows arbitrary path/command arguments. Workspace paths reject traversal and symbolic links/junctions. Media signatures, ffprobe metadata, asset byte hashes, snapshot hashes and output media are checked. Native commands use shell=false and local protocol restrictions.

The filmmaker donor Electron shell disables web security and exposes broad filesystem IPC; it is not shipped. Provider keys are not stored in this browser. No telemetry or cloud upload is required. Static content uses CSP and no remote fonts.

Verified negative cases include forged assets, stale saves, corrupt snapshots, malicious path IDs, disguised playlists, unknown tools, prototype names, unauthenticated API, hostile Origin and stale restart credentials.

Open release gates: OS process sandboxing; streaming bounded uploads/downloads; total workspace quota and stale artifact retention; file-handle verification to narrow local TOCTOU races; crash locks; durable jobs; explicit recovery; private filesystem ACL qualification on Windows; dependency/supply-chain monitoring; portable archive defenses. A hostile local process with the same account is outside this preview's isolation guarantee. Never expose the server on a LAN.

The application dependency audit is currently clear of known npm advisories after replacing the earlier Tailwind 3 dependency chain. A clean npm advisory result is not a security review. OCR LLM attempts failed or skipped; no clean OCR review is claimed. Three fresh-context PStack reviewers completed initial and delta reviews, and all six confirmed must-fixes were resolved with regression evidence. See evidence/review/.
