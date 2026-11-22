import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeDesktopUpdate } from './desktop-update.mjs';
import {
	api,
	assertTagSource,
	checkoutQualitySource,
	command,
	output,
	publishRelease,
	resolveQualitySource,
	resolveRelease,
	stableRelease,
	validateLockfile,
	validateReleaseTag,
	validateReleaseVersions,
} from './release.mjs';

const directory = process.env.RELEASE_SOURCE_DIR || process.cwd();
const repository = process.env.GITHUB_REPOSITORY;
const tag = process.env.RELEASE_TAG;

switch (process.argv[2]) {
	case 'checkout-quality':
		checkoutQualitySource({
			repository,
			workflowSha: process.env.GITHUB_SHA,
			workflowRef: process.env.GITHUB_REF,
			requestedSha: process.env.QUALITY_SOURCE_SHA,
		});
		break;
	case 'quality-source':
		output({
			sha: resolveQualitySource({
				repository,
				workflowSha: process.env.GITHUB_SHA,
				workflowRef: process.env.GITHUB_REF,
				requestedSha: process.env.QUALITY_SOURCE_SHA,
			}),
		});
		break;
	case 'resolve': {
		const result = resolveRelease({ repository, testedSha: process.env.GITHUB_SHA, tag: process.env.RECOVERY_TAG });
		output({ sha: result.sha, tag: result.tag, create: result.create, update: result.update, build: result.build });
		break;
	}
	case 'verify': {
		validateReleaseTag(tag);
		const expectedSha = process.env.EXPECTED_SHA;
		const sha = command('git', ['-C', directory, 'rev-parse', 'HEAD']);
		if (!expectedSha || sha !== expectedSha) {
			throw new Error('The checkout and release tag must match the verified source commit.');
		}
		assertTagSource(repository, tag, expectedSha);
		stableRelease(repository, tag);
		validateReleaseVersions(directory, tag.slice(1));
		validateLockfile(directory);
		output({ version: tag.slice(1), tag });
		break;
	}
	case 'check-lockfile':
		validateLockfile(directory);
		break;
	case 'publish':
		assertTagSource(repository, tag, process.env.EXPECTED_SHA);
		await publishRelease({ repository, tag, image: process.env.IMAGE, digest: process.env.IMAGE_DIGEST });
		break;
	case 'finalize-desktop-update': {
		// The changelog and public keys come from the release being built, which
		// may be checked out apart from these scripts.
		const releaseSource = process.env.DESKTOP_UPDATE_SOURCE_DIR || directory;
		const keyFile = path.join(releaseSource, 'apps/desktop/src/main/update-signing-keys.json');
		finalizeDesktopUpdate({
			directory: process.env.DESKTOP_UPDATE_DIR,
			changelogPath: path.join(releaseSource, 'CHANGELOG.md'),
			expectedVersion: process.env.DESKTOP_UPDATE_VERSION,
			privateKeyPem: process.env.DESKTOP_UPDATE_SIGNING_KEY,
			publicKeys: JSON.parse(readFileSync(keyFile, 'utf8')).publicKeys,
		});
		break;
	}
	case 'check-current':
		output({ current: api(repository, 'git/ref/heads/main').object.sha === process.env.GITHUB_SHA });
		break;
	default:
		throw new Error(`Unknown release operation in ${fileURLToPath(import.meta.url)}.`);
}
