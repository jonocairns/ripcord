# Releases

Ripcord uses [Release Please](https://github.com/googleapis/release-please-action) to maintain one release PR on `main`. It owns the changelog, root package version, client/server/desktop/shared package versions, release manifest, and the annotated workspace versions in `bun.lock`. The plugin SDK keeps its own version. Bun strips comments when regenerating the lockfile: after a dependency update, restore `// x-release-please-version` on the four client/server/desktop/shared workspace version lines. CI checks these markers so a later release cannot silently leave stale lockfile versions.

Use conventional commit messages for changes that should ship. `fix:` produces a patch release, `feat:` a minor release, and `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer a major release. `docs:` and `refactor:` do not trigger a release or appear in the default changelog. Preserve the conventional message when squash-merging a feature or fix PR.

## Repository setup

Create a dedicated App at <https://github.com/settings/apps/new> under `jonocairns`:

| Setting | Value |
| --- | --- |
| GitHub App name | `jonocairns-ripcord-release` (must be globally unique) |
| Description | `Maintains Ripcord release pull requests.` |
| Homepage URL | `https://github.com/jonocairns/ripcord` |
| Callback URL | Leave blank |
| Request user authorization (OAuth) during installation | Unchecked |
| Enable Device Flow | Unchecked |
| Expire user authorization tokens | Keep the default checked |
| Setup URL | Leave blank |
| Redirect on update | Unchecked |
| Webhook Active | Unchecked; no webhook URL or secret needed |
| Repository permission: Contents | Read and write |
| Repository permission: Issues | Read and write |
| Repository permission: Pull requests | Read and write |
| Repository permission: Metadata | Read-only (automatic) |
| All other repository, organization, and account permissions | No access |
| Subscribe to events | None |
| Where can this GitHub App be installed? | Only on this account |

Create the App, then choose **Install App**, install under `jonocairns`, choose **Only select repositories**, and select `ripcord`. On the App's General page, copy the numeric **App ID** and use **Generate a private key** to download its PEM file. No client secret is needed.

In Ripcord's **Settings → Environments**, create `release`. Leave required reviewers unset and the wait timer at zero so publication remains automatic. Set **Deployment branches and tags** to **Selected branches and tags**, add a **Branch** rule for exactly `main`, and add no tag rules. Add these **environment secrets**:

- `RELEASE_BOT_APP_ID`: the numeric App ID from the General page (not the Client ID or installation ID).
- `RELEASE_BOT_PRIVATE_KEY`: the entire downloaded PEM file, including its BEGIN/END lines and newlines.

The bot token authors release PRs so their PR checks run automatically. Tags, releases, asset uploads, and GHCR publication use the workflow's `GITHUB_TOKEN`. Enable GitHub Actions and allow workflow writes in the repository. Preserve the existing Windows signing and Sentry secrets; Windows stable builds require `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

## Shipping

1. Merge changes into `main`. The release workflow runs the same quality checks and platform build checks used by ordinary PRs before Release Please updates its PR. Runs whose tested commit is no longer the head of `main` leave maintenance to the newer run; release creation is restricted to the tested commit that merged the pending release PR.
2. Review and merge the release PR. It contains the version bump and changelog. The migration baseline is the existing `v2.1.53` release, rather than the older package versions left by the previous manual workflow.
3. The workflow creates the version tag and a draft GitHub release, then builds the server/web bundle and uploads the server binaries and `release.json`. It also pushes the versioned `ghcr.io/jonocairns/ripcord:vX.Y.Z` image.
4. Windows, macOS, and Linux desktop builds upload their assets to that same release. Only after every build succeeds does the workflow promote the built Docker image to `latest` and publish the GitHub release automatically.

The draft is an intermediate build state; no manual publication is needed. Stable desktop workflows require an existing release and never create one themselves. The independent Windows beta workflow retains its prerelease behavior.

## Recovering a failed release

For a transient failure, use **Re-run failed jobs** on the original workflow run. This preserves the release outputs for the jobs that already succeeded.

To rebuild a release from scratch, dispatch **Release Server / Web** on `main` and supply its existing `vX.Y.Z` tag. The workflow verifies the stable release exists, checks out that tag, and checks its package and release-manifest versions before rebuilding. Uploads replace matching assets; the workflow publishes only after all platform builds succeed. Leave the tag blank to run normal Release Please maintenance.

Recover the newest pending release before shipping another one. Rebuilding an older release also promotes it to Docker `latest` and GitHub's latest release, so it is a rollback. To fix a source defect, merge a conventional fix and ship a new release; do not move an existing version tag.
