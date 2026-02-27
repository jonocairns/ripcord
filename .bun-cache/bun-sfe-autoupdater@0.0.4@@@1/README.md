# bun-sfe-autoupdater

Auto-updater library for Bun single file executables (SFE), designed to
seamlessly update your standalone Bun applications from GitHub releases.

> [!NOTE] This library is in alpha stage. Bugs, incomplete features and breaking
> changes are to be expected.

## How It Works

This library exposes the `BunUpdater` class, which you can instantiate with your
GitHub repository information. The updater checks for new releases by fetching a
`release.json` file from the latest GitHub release assets. If a newer version is
available for the current platform, it downloads the corresponding binary and
replaces the running application with the new version.

The GitHub release must include a `release.json` file that describes the release
metadata, including version, release date, and available artifacts for different
platforms.

## Installation

```bash
bun add bun-sfe-autoupdater
```

## Quick Start

```typescript
import { BunUpdater } from 'bun-sfe-autoupdater';

const updater = new BunUpdater({
  repoOwner: 'your-username',
  repoName: 'your-repo',
  currentVersion: '1.0.0', // or use process.env.CURRENT_VERSION
  autoStart: true, // automatically spawns the app after update
  ignoreChecksum: false // set to true to skip checksum verification
});

// you can run this to check if updates are available eg: show a notification in the interface
const hasUpdates = await updater.hasUpdates();

// get latest version
const latestVersion = await updater.getLatestVersion();

// if updates are available, it will download and replace the running app with the new version
await updater.checkForUpdates();

// on checkForUpdates you can override certain options
await updater.checkForUpdates({ autoStart: false }); // will not auto start after update
```

## Release Metadata Format

Your GitHub release must include a `release.json` artifact with the following
structure:

```json
{
  "version": "1.0.1",
  "releaseDate": "2025-12-23T12:00:00Z",
  "artifacts": [
    {
      "name": "myapp",
      "target": "linux-x64",
      "size": 12345678,
      "checksum": "sha256-hash-here"
    },
    {
      "name": "myapp",
      "target": "darwin-arm64",
      "size": 12345678,
      "checksum": "sha256-hash-here"
    }
  ]
}
```

This type is exported as `TReleaseMetadata` from the library. You can also use
the `validateReleaseMetadata` function to validate the structure at runtime.

```typescript
import { validateReleaseMetadata } from 'bun-sfe-autoupdater';

// this will throw an error if the structure is invalid
const validMetadata = validateReleaseMetadata(getReleaseMetadataSomehow());

// use validMetadata safely
```

## Private Repositories

To use this library with private GitHub repositories, set the `GITHUB_TOKEN`
environment variable with a personal access token that has access to the repo.

## Supported Targets

- `linux-x64`
- `linux-arm64`
- `windows-x64`
- `darwin-x64`
- `darwin-arm64`

## Environment Variables

### For Your Application

- `CURRENT_VERSION`: The current version of your application (semver format).
  You can inject this at build time or set it in your environment.
- `GITHUB_TOKEN`: GitHub personal access token (required for private
  repositories)

### For Debugging

Enable debug logging by setting the `DEBUG` environment variable:

```bash
DEBUG=updater bun run myapp
```

## Release Channels

You can manage multiple release channels by specifying the `channel` option:

```typescript
const updater = new BunUpdater({
  repoOwner: 'your-username',
  repoName: 'your-repo',
  channel: 'beta',
  currentVersion: '1.0.0'
});
```

The updater will look for `release-beta.json` instead of `release.json` in the
release artifacts.

## Private Repositories

For private repositories, set the `GITHUB_TOKEN` environment variable:

```bash
GITHUB_TOKEN=ghp_your_token_here bun run myapp
```

The updater will automatically use the token for authentication when accessing
private repos.

## License

MIT
