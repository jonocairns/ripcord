import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	buildReleaseNotes,
	buildUpdateSignaturePayload,
	finalizeDesktopUpdate,
	isTrustedUpdateSignature,
	parseChangelog,
	parseUpdateMetadata,
} from './desktop-update.mjs';

const createKeys = () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return {
		privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
		publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
	};
};

const latestYml = (version, fileName, sha512) =>
	[
		`version: ${version}`,
		'files:',
		`  - url: ${fileName}`,
		`    sha512: ${sha512}`,
		'    size: 7',
		`path: ${fileName}`,
		`sha512: ${sha512}`,
		"releaseDate: '2026-11-21T01:55:35.962Z'",
		'',
	].join('\n');

const changelog = [
	'# Changelog',
	'',
	'## [2.7.0](https://github.com/jonocairns/ripcord/compare/v2.6.6...v2.7.0) (2026-11-22)',
	'',
	'',
	'### Features',
	'',
	'* install desktop updates in the background ([#450](https://github.com/jonocairns/ripcord/issues/450)) ([abc1234](https://github.com/jonocairns/ripcord/commit/abc1234))',
	'',
	'',
	'### Bug Fixes',
	'',
	"* **desktop:** keep the window's `size` after restarting ([#451](https://github.com/jonocairns/ripcord/issues/451)) ([def5678](https://github.com/jonocairns/ripcord/commit/def5678))",
	'* **ci:** stop manual review runs from executing fork code ([#452](https://github.com/jonocairns/ripcord/issues/452)) ([0aa1111](https://github.com/jonocairns/ripcord/commit/0aa1111))',
	'',
	'## [2.6.6](https://github.com/jonocairns/ripcord/compare/v2.6.5...v2.6.6) (2026-11-20)',
	'',
	'',
	'### Bug Fixes',
	'',
	'* apply speaker volume to sound effects ([#441](https://github.com/jonocairns/ripcord/issues/441)) ([4dc68bb](https://github.com/jonocairns/ripcord/commit/4dc68bb))',
	'',
	'## [2.6.5](https://github.com/jonocairns/ripcord/compare/v2.6.4...v2.6.5) (2026-11-14)',
	'',
	'',
	'### Miscellaneous Chores',
	'',
	'* bump dependencies ([#437](https://github.com/jonocairns/ripcord/issues/437)) ([1111111](https://github.com/jonocairns/ripcord/commit/1111111))',
	'',
].join('\n');

const withReleaseDirectory = (run) => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'ripcord-desktop-update-'));
	try {
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
};

const writeRelease = (directory, version, contents = 'install') => {
	const fileName = `Ripcord.Desktop.Setup.${version}.exe`;
	writeFileSync(path.join(directory, fileName), contents);
	const sha512 = createHash('sha512').update(contents).digest('base64');
	writeFileSync(path.join(directory, 'latest.yml'), latestYml(version, fileName, sha512));
	writeFileSync(path.join(directory, 'CHANGELOG.md'), changelog);
	return { fileName, sha512 };
};

test('the signed payload matches the format the desktop app verifies', () => {
	assert.equal(
		buildUpdateSignaturePayload({ version: '2.7.0', fileName: 'Ripcord.Desktop.Setup.2.7.0.exe', sha512: 'abc==' }),
		'ripcord-desktop-update-v1\nversion=2.7.0\nfile=Ripcord.Desktop.Setup.2.7.0.exe\nsha512=abc==',
	);
});

test('reads the installer from electron-builder metadata', () => {
	assert.deepEqual(parseUpdateMetadata(latestYml('2.6.6', 'Ripcord.Desktop.Setup.2.6.6.exe', 'TJU3==')), {
		version: '2.6.6',
		fileName: 'Ripcord.Desktop.Setup.2.6.6.exe',
		sha512: 'TJU3==',
	});
});

test('rejects metadata that is ambiguous, prerelease, or already finalized', () => {
	const valid = latestYml('2.6.6', 'Ripcord.Desktop.Setup.2.6.6.exe', 'TJU3==');
	assert.throws(() => parseUpdateMetadata(valid.replace('version: 2.6.6', 'version: 0.0.0-beta.4')), /stable version/);
	assert.throws(
		() => parseUpdateMetadata(valid.replace('sha512: TJU3==\nrelease', 'sha512: OTHER==\nrelease')),
		/match/,
	);
	assert.throws(() => parseUpdateMetadata(`${valid}ripcordUpdateSignature: 'abc'\n`), /already contains/);
	assert.throws(
		() => parseUpdateMetadata(valid.replace('    size: 7\n', '    size: 7\n  - url: Second.exe\n    sha512: X==\n')),
		/exactly one installer/,
	);
});

test('turns the changelog into plain notes without links, scopes, or CI-only entries', () => {
	const [release] = parseChangelog(changelog);
	assert.deepEqual(release, {
		version: '2.7.0',
		date: '2026-11-22',
		features: ['Install desktop updates in the background'],
		fixes: ["Keep the window's size after restarting"],
	});
});

test('release notes start at the released version and skip versions without user-facing changes', () => {
	assert.deepEqual(
		buildReleaseNotes(changelog, '2.6.6').versions.map((entry) => entry.version),
		['2.6.6'],
	);
	assert.deepEqual(
		buildReleaseNotes(changelog, '2.7.0').versions.map((entry) => entry.version),
		['2.7.0', '2.6.6'],
	);
	assert.throws(() => buildReleaseNotes(changelog, '9.9.9'), /no entry/);
});

test('finalizing signs the installer and appends notes the updater can read back', () => {
	withReleaseDirectory((directory) => {
		const keys = createKeys();
		const { fileName, sha512 } = writeRelease(directory, '2.7.0');

		finalizeDesktopUpdate({
			directory,
			changelogPath: path.join(directory, 'CHANGELOG.md'),
			privateKeyPem: keys.privateKeyPem,
			publicKeys: [keys.publicKey],
			log: () => {},
		});

		const finalized = readFileSync(path.join(directory, 'latest.yml'), 'utf8');
		const signature = finalized.match(/^ripcordUpdateSignature: '(.+)'$/m)?.[1];
		assert.ok(signature);
		assert.ok(isTrustedUpdateSignature({ version: '2.7.0', fileName, sha512 }, signature, [keys.publicKey]));
		assert.equal(isTrustedUpdateSignature({ version: '2.6.9', fileName, sha512 }, signature, [keys.publicKey]), false);

		const notesLine = finalized.match(/^ripcordReleaseNotes: '(.+)'$/m)?.[1];
		assert.ok(notesLine);
		const notes = JSON.parse(notesLine.replaceAll("''", "'"));
		assert.deepEqual(notes.versions[0].fixes, ["Keep the window's size after restarting"]);
	});
});

test('finalizing fails when the key does not match the committed public key', () => {
	withReleaseDirectory((directory) => {
		writeRelease(directory, '2.7.0');
		assert.throws(
			() =>
				finalizeDesktopUpdate({
					directory,
					changelogPath: path.join(directory, 'CHANGELOG.md'),
					privateKeyPem: createKeys().privateKeyPem,
					publicKeys: [createKeys().publicKey],
					log: () => {},
				}),
			/does not match a public key/,
		);
	});
});

test('finalizing fails when the installer differs from latest.yml', () => {
	withReleaseDirectory((directory) => {
		const keys = createKeys();
		const { fileName } = writeRelease(directory, '2.7.0');
		writeFileSync(path.join(directory, fileName), 'tampered');
		assert.throws(
			() =>
				finalizeDesktopUpdate({
					directory,
					changelogPath: path.join(directory, 'CHANGELOG.md'),
					privateKeyPem: keys.privateKeyPem,
					publicKeys: [keys.publicKey],
					log: () => {},
				}),
			/does not match the sha512/,
		);
	});
});

test('a broken changelog skips the notes but still signs the update', () => {
	withReleaseDirectory((directory) => {
		const keys = createKeys();
		writeRelease(directory, '2.7.0');
		writeFileSync(path.join(directory, 'CHANGELOG.md'), '# Changelog\n');
		const logs = [];

		finalizeDesktopUpdate({
			directory,
			changelogPath: path.join(directory, 'CHANGELOG.md'),
			privateKeyPem: keys.privateKeyPem,
			publicKeys: [keys.publicKey],
			log: (line) => logs.push(line),
		});

		const finalized = readFileSync(path.join(directory, 'latest.yml'), 'utf8');
		assert.match(finalized, /^ripcordUpdateSignature: /m);
		assert.doesNotMatch(finalized, /^ripcordReleaseNotes: /m);
		assert.ok(logs.some((line) => line.includes('Skipping desktop release notes')));
	});
});
