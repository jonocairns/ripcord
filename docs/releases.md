# Releases

Ripcord uses [Release Please](https://github.com/googleapis/release-please-action) to maintain one release PR on `main`. It owns the changelog, root package version, client/server/desktop/shared package versions, release manifest, and the annotated workspace versions in `bun.lock`. The plugin SDK keeps its own version. Bun strips comments when regenerating the lockfile: after a dependency update, restore `// x-release-please-version` on the four client/server/desktop/shared workspace version lines. CI verifies that each marker sits on its intended workspace version and that the version agrees with the corresponding package, so a later release cannot silently update the wrong value or leave stale versions.

Use conventional commit messages for changes that should ship. `fix:` produces a patch release, `feat:` a minor release, and `feat!:` / `fix!:` or a `BREAKING CHANGE:` footer a major release. `docs:` and `refactor:` do not trigger a release or appear in the default changelog. The repository squash-merges PRs, and a multi-commit PR lands with its PR title as the commit subject, so give PR titles the conventional prefix too. Release Please ignores commits without one.

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
| Repository permission: Workflows | Read and write |
| Repository permission: Metadata | Read-only (automatic) |
| All other repository, organization, and account permissions | No access |
| Subscribe to events | None |
| Where can this GitHub App be installed? | Only on this account |

Create the App, then choose **Install App**, install under `jonocairns`, choose **Only select repositories**, and select `ripcord`. On the App's General page, copy the numeric **App ID** and use **Generate a private key** to download its PEM file. No client secret is needed.

In Ripcord's **Settings → Environments**, create `release`. Leave required reviewers unset and the wait timer at zero so publication remains automatic. Set **Deployment branches and tags** to **Selected branches and tags**, add a **Branch** rule for exactly `main`, and add no tag rules. Add these **environment secrets**:

- `RELEASE_BOT_APP_ID`: the numeric App ID from the General page (not the Client ID or installation ID).
- `RELEASE_BOT_PRIVATE_KEY`: the entire downloaded PEM file, including its BEGIN/END lines and newlines.

The bot token authors release PRs so their PR checks run automatically. A separate bot token creates tags and draft releases. Only that token requests Workflows write permission, which [GitHub requires](https://docs.github.com/en/rest/releases/releases#create-a-release) for historical release commits whose workflow files differ from current main; `GITHUB_TOKEN` cannot grant it. Asset uploads, final publication, and GHCR use the workflow's `GITHUB_TOKEN`. If updating an existing App, save this permission and accept the updated permissions for its installation. Enable GitHub Actions and allow workflow writes in the repository. Preserve the existing Windows signing and Sentry secrets; Windows stable builds require `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.

## Shipping

1. Merge changes into `main`. The release workflow runs the same quality checks and platform build checks used by ordinary PRs before Release Please updates its PR. PR maintenance runs only while the workflow commit is still the head of `main`. Release discovery independently finds an existing merged pending release PR on that main history, so newer merges or superseded queued runs cannot strand it. For releases and recovery, all quality/platform checks run against the verified release commit, and every build checks out the same immutable SHA. The reusable quality workflow independently verifies any requested commit belongs to its main history before running checked-out code or using build caches; ordinary PR checks use their workflow merge commit.
2. Review and merge the release PR. It contains the version bump and changelog. The migration baseline is the existing `v2.1.53` release, rather than the older package versions left by the previous manual workflow.
3. The workflow creates the version tag and a draft GitHub release, then builds the server/web bundle. Before uploading anything, it boots the Linux server binary in the shipped Debian image and checks its health, version, and web interface. It then uploads the server binaries and `release.json` and pushes the versioned `ghcr.io/jonocairns/ripcord:vX.Y.Z` image.
4. Windows, macOS, and Linux desktop builds upload their assets to that same release. Only after every build succeeds does the workflow publish the GitHub release automatically, then promote the built Docker image to `latest`. Each publication operation has three bounded attempts; Docker promotion cannot start until the GitHub assets are available.

The draft is an intermediate build state; no manual publication is needed. Stable desktop workflows require an existing release and never create one themselves. The independent Windows beta workflow retains its prerelease behavior.

## Recovering a failed release

For a transient failure, use **Re-run failed jobs** on the original workflow run. This preserves the release outputs for the jobs that already succeeded.

To rebuild a pipeline-created release from scratch, dispatch **Release Server / Web** on `main` and supply its existing `vX.Y.Z` tag. Recovery requires a tag pointing to a merged Release Please PR labeled `autorelease: tagged`, on the current main history, with a matching release manifest. Historical releases from the previous manual pipeline, including `v2.1.53`, are unsupported. The workflow resolves and validates the tag before quality checks, checks out its immutable commit SHA, and verifies package and release-manifest versions before rebuilding. Uploads replace matching assets; the workflow publishes only after all platform builds succeed. Leave the tag blank to run normal Release Please maintenance or finish a merged pending release that has not yet acquired a tag. This also recovers a release whose original queued run was superseded.

If GitHub publication succeeds but Docker promotion exhausts its retries, the GitHub release remains available and the job fails with an explicit recovery message. Re-run the failed publish job to converge both channels on the same version; its operations are idempotent. If GitHub publication fails, Docker `latest` is untouched.

While a merged release PR is pending, every run retests its release commit, so a persistent quality failure there blocks later releases. The checked-out code is fixed, but the workflow definitions (runners, toolchains, actions) come from the newest main commit: if an environmental change broke the checks, fix the workflow on `main` and the next run retests the pending release with it.

Recover the newest pending release before shipping another one. Rebuilding an older release also promotes it to Docker `latest` and GitHub's latest release, so it is a rollback. To fix a source defect, merge a conventional fix and ship a new release; do not move an existing version tag.
