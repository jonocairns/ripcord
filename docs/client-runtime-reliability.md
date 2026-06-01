# Client Runtime Reliability Notes

This sweep focused on the client boundary where the same React bundle runs as a
normal web app and as the Electron desktop renderer. The high-value reliability
surface is small: configured server URLs, auth token rotation, public asset/file
URLs, desktop bridge compatibility, and client-side diagnostics.

## Runtime Shape

- `apps/client/src/main.tsx` initializes runtime server configuration before the
  React tree renders. Keep network call sites behind helpers that read
  `getRuntimeServerConfig()` rather than reading `window.location` directly.
- `apps/client/src/runtime/server-config.ts` is the source of truth for desktop
  server URLs. It normalizes missing schemes to `http://`, strips path/query/hash
  components, accepts bracketed IPv6 hosts, and rejects non-HTTP protocols.
- `apps/client/src/helpers/get-file-url.ts` deliberately separates full HTTP
  origins (`getUrlFromServer`) from host-only websocket targets
  (`getHostFromServer`). Preserve that split; websocket reconnect and HTTP file
  fetches fail in different ways when the two are conflated.
- Desktop renderer assets may be loaded from `file://`. Helpers such as
  `getPublicAssetUrl()` account for that, while server data still needs to go
  through the configured HTTP server URL.

## Existing Reliability Anchors

- Auth refresh is single-flight per refresh token in
  `apps/client/src/helpers/auth.ts`. This avoids racing the server's rotating
  refresh tokens and prevents late stale refreshes from overwriting newer local
  tokens.
- Refresh requests are timeout-bound, and timeout/network failures preserve local
  auth state. This is important for real network outages: a hung refresh should
  not sign a valid user out.
- `apps/client/src/lib/trpc.ts` keeps a session-scoped websocket client instance
  id in `sessionStorage`, with an in-memory fallback when storage is unavailable.
  That makes reconnect recovery more stable without assuming storage always
  works.
- `apps/client/src/runtime/desktop-capabilities.ts` normalizes older desktop
  bridge capability payloads. New desktop bridge fields should stay optional on
  the renderer side until shipped desktop clients have aged out.
- Client error reporting sanitizes request metadata, user identity, tokens,
  URLs, and nested context before sending to Sentry. Desktop stack frames are
  rewritten from `file://` asset paths to server-hosted assets when the desktop
  and server bundles match.
- `parseTrpcErrors()` accepts only proven field-error maps or parsed tRPC
  validation issue arrays. Unexpected values fall back to `_general` instead of
  leaking `null`, arrays, or arbitrary objects into form error state.

## Small High-Value Wins

- Keep focused tests around `getFileUrl()` covering spaces, unicode, reserved
  path delimiters, and private file access tokens. The server tests already
  expect public file names to be addressed as one encoded path segment; a
  client-side regression here would break images, attachments, avatars, and emoji
  rendering across the app.
- Keep public asset URL helpers centralized through `getPublicAssetUrl()`. This
  helper handles both normal web origins and packaged Electron `file://` origins;
  new desktop asset additions should go through it instead of open-coding
  protocol checks.
- Keep unit coverage that `getHostFromServer()` and `getUrlFromServer()` use
  desktop runtime config once initialized. The behavior is simple, but failures
  would be broad: login, uploads, invites, file previews, and websocket
  connection all depend on this contract.
- Prefer compatibility adapters for new desktop bridge fields. Add new
  `TDesktopBridge` methods as optional at first, normalize their output at the
  client boundary, and only make them required after older shipped desktop builds
  are no longer supported.
- Keep auth refresh diagnostics visible but non-destructive. `console.warn` on
  timeout/network failures is currently a good compromise; if this moves to
  Sentry, preserve the current rule that transient refresh failures do not clear
  tokens unless the same refresh token is rejected as invalid.

## Review Checklist For This Area

- Does the code run correctly when `window.location.protocol === 'file:'`?
- Does it use `getUrlFromServer()` for HTTP and `getHostFromServer()` for
  websocket host strings?
- Could the server URL include an IPv6 host, an HTTPS origin, or a stale desktop
  setting with a path/query suffix?
- Does a failed network call preserve user state unless the server explicitly
  invalidates the current token?
- Are new desktop bridge fields backward compatible with already shipped
  desktop clients?
- Are any diagnostics or error contexts sanitized before they can include tokens,
  user identifiers, invite URLs, or private channel/file URLs?
