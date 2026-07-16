# Ripcord Plugin SDK

TypeScript contracts for server plugins. Plugins are experimental, and the API
may change between releases.

The package is currently private and is not published to a registry. Plugins in
this repository can depend on `@sharkord/plugin-sdk` through the workspace.
Standalone plugin projects must point their development dependency at a local
Ripcord checkout or link the package locally. Type-only SDK imports are erased
from the compiled plugin and are not needed by the server at runtime.

## Plugin layout

Each plugin is a directory containing a `package.json` and a compiled JavaScript
entry file. The manifest uses the existing `sharkord` compatibility key:

```json
{
  "name": "my-plugin",
  "version": "0.0.1",
  "type": "module",
  "sharkord": {
    "entry": "index.js",
    "author": "Me",
    "description": "Example Ripcord plugin",
    "homepage": "https://example.com/my-plugin",
    "logo": "https://example.com/logo.png"
  }
}
```

Required fields are `name`, a semantic `version`, and `sharkord.entry`,
`sharkord.author`, and `sharkord.description`. The entry must end in `.js`.
`homepage` and `logo` are optional; `homepage`, when present, must be a URL.

## Entry module

The entry must export `onLoad`. It may also export `onUnload`:

```ts
import type { PluginContext, UnloadPluginContext } from '@sharkord/plugin-sdk';

const onLoad = (ctx: PluginContext) => {
	ctx.log('Plugin loaded');

	ctx.events.on('user:joined', ({ userId, username }) => {
		ctx.log(`${username} joined as user ${userId}`);
	});
};

const onUnload = (ctx: UnloadPluginContext) => {
	ctx.log('Plugin unloaded');
};

export { onLoad, onUnload };
```

`onLoad` may be synchronous or asynchronous. Event listeners, commands, and
registered setting definitions are removed when the plugin unloads.
`UnloadPluginContext` deliberately exposes only logging methods; retain any
resource handles your plugin needs to close in module state.

Compile TypeScript to the JavaScript entry named by the manifest before
installing the plugin.

## Context APIs

### Logging

`ctx.log`, `ctx.debug`, and `ctx.error` write to the plugin log surfaced in the
server administration UI.

### Events

`ctx.events.on` supports these server events:

- `user:joined`
- `user:left`
- `message:created`
- `message:updated`
- `message:deleted`
- `voice:runtime_initialized`
- `voice:runtime_closed`

Handlers may be synchronous or asynchronous. Use the SDK’s `EventPayloads`
typing rather than duplicating event payload shapes.

### Commands

Commands are available from the client command UI after registration:

```ts
ctx.commands.register({
	name: 'greet',
	description: 'Greet a user',
	args: [
		{
			name: 'username',
			type: 'string',
			description: 'The user to greet',
			required: true,
		},
	],
	async executes(invoker, args: { username: string }) {
		ctx.log(`Greeting requested by ${invoker.userId}`);
		return `Hello, ${args.username}!`;
	},
});
```

Arguments may be strings, numbers, or booleans. Mark sensitive arguments with
`sensitive: true` so the client masks their value. Command handlers receive the
invoking user id and, when applicable, the user’s current voice channel id.

### Settings

`ctx.settings.register` declares typed string, number, or boolean settings and
returns `get`/`set` accessors. Settings appear in the plugin administration UI
and are persisted by the server.

### Voice integration

`ctx.actions.voice` can access a channel’s mediasoup router, create an external
audio/video stream, and read the server listen configuration. External stream
handles support `update` and `remove`. Treat mediasoup resources as owned
resources and close them during unload.

## Installation

Copy each built plugin directory into the server data directory’s `plugins`
folder:

```text
<server data>/plugins/my-plugin/package.json
<server data>/plugins/my-plugin/index.js
```

In development, server data is relative to the server working directory under
`data/`. Production uses the platform application-data directory. The
authoritative path construction is in `apps/server/src/helpers/paths.ts`.

Enable plugins globally in server settings, then enable the individual plugin in
the Plugins administration section. Enabling and disabling an installed plugin
loads and unloads it without a server restart.

## Source of truth

- Public SDK types: `packages/plugin-sdk/src/index.ts`
- Manifest validation and command types: `packages/shared/src/plugins.ts`
- Runtime behavior: `apps/server/src/plugins/index.ts`

The SDK has no separate generated API reference. Keep examples aligned with
those files when the experimental contract changes.
