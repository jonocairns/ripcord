import z from "zod";

// The single entry point for zod in renderer-executed code. Importing zod
// directly is banned in packages/shared and apps/client (biome
// noRestrictedImports), so this module is the only place the configuration
// below can be applied — you cannot construct a schema without it having run.
//
// Why: zod v4 ships a JIT fast-path that compiles object validators with the
// `Function` constructor, and probes `new Function("")` up front to check eval
// is allowed. The Electron renderer's CSP enforces no `unsafe-eval` (see
// apps/desktop/src/main/renderer-csp.ts), so that probe is blocked and emits a
// `securitypolicyviolation` on every load. `jitless` skips both the probe and
// the JIT, falling back to the interpreter.
//
// Gated on `window` so only the renderer goes jitless: the Bun server imports
// zod directly and keeps the JIT, a real win on its tRPC validation hot path.
// (`in globalThis` rather than the `window` identifier so this typechecks
// without the DOM lib.) The flag lives on `globalThis`, so one call configures
// every zod copy in the process.
if ("window" in globalThis) {
  z.config({ jitless: true });
}

export default z;
export * from "zod";
