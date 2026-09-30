# Reviewed experimental migration branch

This branch contains two bounded, runnable experiments while keeping the original Electron frontend/application:

- `go-prototype`: Go + plain HTML/CSS/JS text runner, versioned exact/contains contract, offline echo or explicitly configured local model HTTP, cancellation and persisted results
- `go-viewer`: Go serving the compiled existing React Statistics view, inventory and all 58 locale catalogs; read-only synthetic/copied JSON snapshots with strict validation, no model calls or mutation routes

This is not a completed BenchForge migration. Existing boolean/numeric/manual/rubric/maze/code/sandbox/MCP functionality and the full UI remain in the original app. New evaluator scores cannot be merged into legacy rankings. The preferred next architecture preserves the compiled frontend behind a typed Go boundary; see the compatibility matrix.

Reviewed code milestones: text runner `ced45d9`, readonly viewer `6912f4d`. The final packaging commit adds notices and documentation only. Upcoming SQLite-copy compatibility work is excluded from this branch until separately reviewed.

Validation: 25 text-runner Go race tests; 12 viewer Go race tests; 63 frontend tests; Go vet; both frontend builds; actual Linux-binary loopback smoke with persisted output or unchanged read-only snapshot as applicable. Native Windows runtime, rendered browser UI, real TTS/LLM inference, user databases, and full feature parity are not verified. Windows cross-compilation is not native testing.

Keep localhost servers private and do not reverse-proxy them. Report/snapshot data can include private prompts and responses. The readonly projection strips credential fields but preserves response notes required by legacy code-presence display. Ordinary UI language preferences can be saved in the browser; snapshot/application data is not written.
