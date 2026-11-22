import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Adds Ripcord's own update signature and release notes to the Windows
// latest.yml. The desktop app verifies the signature before installing
// (apps/desktop/src/main/update-verification.ts builds the same payload) and
// shows the notes while the update downloads.
const SIGNATURE_FIELD = 'ripcordUpdateSignature';
const RELEASE_NOTES_FIELD = 'ripcordReleaseNotes';
const PAYLOAD_HEADER = 'ripcord-desktop-update-v1';
const MAX_RELEASE_NOTE_VERSIONS = 10;
const HIDDEN_CHANGELOG_SCOPES = new Set(['ci']);

// notesSha256 is the hex sha256 of the exact ripcordReleaseNotes string, or ''
// when the release has no notes.
export function buildUpdateSignaturePayload({ version, fileName, sha512, notesSha256 }) {
	return [
		PAYLOAD_HEADER,
		`version=${version}`,
		`file=${fileName}`,
		`sha512=${sha512}`,
		`notes-sha256=${notesSha256}`,
	].join('\n');
}

export function hashReleaseNotes(notesText) {
	return notesText === undefined ? '' : createHash('sha256').update(notesText, 'utf8').digest('hex');
}

function unquoteYamlScalar(value) {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && (trimmed[0] === "'" || trimmed[0] === '"') && trimmed.at(-1) === trimmed[0]) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function readTopLevelField(text, key) {
	const match = text.match(new RegExp(`^${key}:(.*)$`, 'm'));
	return match ? unquoteYamlScalar(match[1]) : undefined;
}

// Reads electron-builder's latest.yml: one installer in `files`, mirrored by the
// legacy top-level `path` and `sha512` fields.
export function parseUpdateMetadata(text) {
	if (
		readTopLevelField(text, SIGNATURE_FIELD) !== undefined ||
		readTopLevelField(text, RELEASE_NOTES_FIELD) !== undefined
	) {
		throw new Error('latest.yml already contains Ripcord update fields.');
	}

	const version = readTopLevelField(text, 'version');
	if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`latest.yml must name a stable version, got ${JSON.stringify(version)}.`);
	}

	const files = [...text.matchAll(/^ {2}- url:(.*)\n {4}sha512:(.*)$/gm)].map((match) => ({
		fileName: unquoteYamlScalar(match[1]),
		sha512: unquoteYamlScalar(match[2]),
	}));
	if (files.length !== 1 || !files[0].fileName.toLowerCase().endsWith('.exe') || !files[0].sha512) {
		throw new Error('latest.yml must list exactly one installer with a sha512.');
	}

	const [file] = files;
	if (readTopLevelField(text, 'path') !== file.fileName || readTopLevelField(text, 'sha512') !== file.sha512) {
		throw new Error('latest.yml top-level path and sha512 must match its installer entry.');
	}

	return { version, fileName: file.fileName, sha512: file.sha512 };
}

export function signUpdate(update, privateKeyPem) {
	const payload = Buffer.from(buildUpdateSignaturePayload(update), 'utf8');
	return sign(null, payload, createPrivateKey(privateKeyPem)).toString('base64');
}

export function isTrustedUpdateSignature(update, signature, publicKeys) {
	const payload = Buffer.from(buildUpdateSignaturePayload(update), 'utf8');
	return publicKeys.some((publicKey) =>
		verify(
			null,
			payload,
			createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
			Buffer.from(signature, 'base64'),
		),
	);
}

function cleanChangelogItem(text) {
	const scope = text.match(/^\*\*([^*]+):\*\*\s*/);
	if (scope && HIDDEN_CHANGELOG_SCOPES.has(scope[1].trim().toLowerCase())) {
		return undefined;
	}

	const cleaned = text
		.replace(/^\*\*[^*]+:\*\*\s*/, '')
		.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*]/g, '')
		.trim();
	return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : undefined;
}

function resolveChangelogSection(title) {
	if (/^features$/i.test(title)) return 'features';
	if (/^(bug fixes|performance improvements)$/i.test(title)) return 'fixes';
	return undefined;
}

// Parses the Release Please CHANGELOG.md into user-facing notes. Only
// top-level feature, fix, and performance bullets are kept; PR and commit links
// are removed.
export function parseChangelog(text) {
	const versions = [];
	let current;
	let section;

	for (const line of text.split('\n')) {
		const heading = line.match(/^## \[?(\d+\.\d+\.\d+)\]?(?:\([^)]*\))?(?:\s+\((\d{4}-\d{2}-\d{2})\))?/);
		if (heading) {
			current = { version: heading[1], date: heading[2], features: [], fixes: [] };
			versions.push(current);
			section = undefined;
			continue;
		}

		const subheading = line.match(/^### (.+)$/);
		if (subheading) {
			section = resolveChangelogSection(subheading[1].trim());
			continue;
		}

		const item = line.match(/^\* (.+)$/);
		if (item && current && section) {
			const cleaned = cleanChangelogItem(item[1]);
			if (cleaned) current[section].push(cleaned);
		}
	}

	return versions;
}

export function buildReleaseNotes(changelogText, version) {
	const versions = parseChangelog(changelogText);
	const releaseIndex = versions.findIndex((entry) => entry.version === version);
	if (releaseIndex === -1) {
		throw new Error(`CHANGELOG.md has no entry for ${version}.`);
	}

	return {
		versions: versions
			.slice(releaseIndex)
			.filter((entry) => entry.features.length > 0 || entry.fixes.length > 0)
			.slice(0, MAX_RELEASE_NOTE_VERSIONS),
	};
}

function quoteYamlString(value) {
	return `'${value.replaceAll("'", "''")}'`;
}

function hashFile(filePath) {
	return createHash('sha512').update(readFileSync(filePath)).digest('base64');
}

export function finalizeDesktopUpdate({
	directory,
	changelogPath,
	expectedVersion,
	privateKeyPem,
	publicKeys,
	log = console.log,
}) {
	if (!directory) {
		throw new Error('DESKTOP_UPDATE_DIR must point at the electron-builder output directory.');
	}
	if (!privateKeyPem) {
		throw new Error('DESKTOP_UPDATE_SIGNING_KEY is required to sign the Windows update.');
	}

	const metadataPath = path.join(directory, 'latest.yml');
	const metadataText = readFileSync(metadataPath, 'utf8');
	const metadata = parseUpdateMetadata(metadataText);
	if (metadata.version !== expectedVersion) {
		throw new Error(`latest.yml is for ${metadata.version}, but the release is ${expectedVersion}.`);
	}

	if (hashFile(path.join(directory, metadata.fileName)) !== metadata.sha512) {
		throw new Error(`${metadata.fileName} does not match the sha512 in latest.yml.`);
	}

	// Notes are a nice-to-have: a changelog problem must not block the release.
	let notesText;
	try {
		notesText = JSON.stringify(buildReleaseNotes(readFileSync(changelogPath, 'utf8'), metadata.version));
	} catch (error) {
		log(`::warning::Skipping desktop release notes: ${error instanceof Error ? error.message : String(error)}`);
	}

	const update = { ...metadata, notesSha256: hashReleaseNotes(notesText) };
	const signature = signUpdate(update, privateKeyPem);
	if (!isTrustedUpdateSignature(update, signature, publicKeys)) {
		throw new Error('The signing key does not match a public key in update-signing-keys.json.');
	}

	const fields = [`${SIGNATURE_FIELD}: ${quoteYamlString(signature)}`];
	if (notesText !== undefined) {
		fields.push(`${RELEASE_NOTES_FIELD}: ${quoteYamlString(notesText)}`);
	}

	const separator = metadataText.endsWith('\n') ? '' : '\n';
	writeFileSync(metadataPath, `${metadataText}${separator}${fields.join('\n')}\n`);
	log(`Signed ${metadata.fileName} (${metadata.version}).`);
}
