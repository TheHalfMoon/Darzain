# Darzain

Darzain is a local creative production workspace for humans and agents. This engineering preview imports real media, edits a multitrack timeline, records shot intent, saves editable projects, and exports verified MP4 video with titles and explicit audio mixing.

## Run locally

Prerequisites: Node.js 24.11+ in the 24.x line, npm, FFmpeg and ffprobe on PATH. Titles require a local TTF font (Windows Arial, Linux DejaVu Sans or macOS Arial); set DARZAIN_FONT when necessary. No provider account or cloud service is required for this workflow.

```sh
npm ci --ignore-scripts
npm run build
npm start
```

Open http://127.0.0.1:4318. Create a project, import an image and an audio file, click each asset to add it, add a scene and title, save, then export. Imported video audio must currently be supplied as a separate audio asset. Camera controls record shot intent; they do not transform footage.

The default workspace is .darzain/ beside the application. DARZAIN_WORKSPACE can select another trusted local directory. DARZAIN_PORT changes the loopback port. Do not expose this service to a network. See [security boundaries](docs/SECURITY.md).

## Agent use

```sh
npm run cli -- darzain.project.list '{}'
```

GET /api/v1/tools exposes versioned schemas. Both browser and CLI use the same validated operations. CLI reads the local workspace token; keep it private. See [agent platform](docs/AGENT_PLATFORM.md).

## Qualification

```sh
npm run lint
npm run format:check
npm run provenance:check
npm test
npm run build
```

Browser E2E uses installed Edge by default. Set DARZAIN_BROWSER_CHANNEL=chromium after installing Chromium with Playwright for CI. Start the production server before npm run test:e2e.

The current product is an engineering preview. Recovery, durable job history, portable project packaging, model generation, 3D composition, desktop installers and full release qualification remain open. Read [CURRENT](specs/CURRENT.md) for the exact next task. Required donor notices and provenance are retained; this is not an empty application scaffold.

## License

GPL-3.0-or-later for the combined application, with retained Apache-2.0 components and third-party notices. See LICENSE, NOTICE and notices/.
