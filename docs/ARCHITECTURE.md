# Architecture

A single strict schema owns projects, assets, scenes, tracks and clips. Frames are integer 30-fps positions. UUIDs are globally unique within a project; asset references and source ranges are validated. Browser adapters convert canonical records to donor editor objects. Donor state is not a second source of truth.

The React editor reuses the filmmaker Timeline, PreviewPlayer and utility modules. A loopback Node service hosts static assets, authenticated REST tools and local media operations. CreativeAPI is shared by browser and CLI. ProjectStore owns canonical JSON snapshots, checksummed heads and validated content-addressed media. RenderQueue serializes real FFmpeg jobs, exposes state and supports cancellation.

FFmpeg receives structured arguments with shell disabled. Inputs are local validated media. Titles use text files and expansion=none. Picture layers are ordered by track, audio is explicitly mixed, and completed artifacts are published only after ffprobe validation. Native codecs run as child processes and are not OS-sandboxed yet.

Generation will be isolated behind a capability/job/artifact contract; ComfyUI and Wan2GP adapters must map actual backend identity, resource limits, cancellation and restart reconciliation. A worker result may enter the project only through the same media validation path. Remote providers will be optional, configured explicitly, and secret-bearing calls will stay out of browser state.

The scoped foundation choice and rejected alternatives are in [ADR 0001](adr/0001-qualified-editor-foundation.md). Recovery, durable jobs, database-backed catalogs, archive formats and desktop boundaries require measured qualification before adoption.
