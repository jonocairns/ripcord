# Archived Voice Processing

This folder preserves the removed sidecar voice-processing implementation.

Archived snapshot:

- `src/voice_filter_core.rs`
- `src/main.rs`
- `src/pipeline.rs`

The live sidecar now ships a compatibility stub in
`apps/desktop/sidecar/src/voice_filter_core.rs` that reports voice processing
as archived and no longer starts the old pipeline.
