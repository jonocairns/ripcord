import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import updateSigningKeys from './update-signing-keys.json';

// Windows updates are verified with Ripcord's own Ed25519 key instead of
// Authenticode: the installer's certificate is self-signed, so Windows never
// reports it as trusted on other machines. The release workflow signs the
// payload below and appends the signature to latest.yml
// (scripts/release/desktop-update.mjs builds the same payload). The payload
// covers the release notes too, so everything the app reads from latest.yml is
// signed.
const UPDATE_SIGNATURE_FIELD = 'ripcordUpdateSignature';
const RELEASE_NOTES_FIELD = 'ripcordReleaseNotes';
const UPDATE_SIGNATURE_PAYLOAD_HEADER = 'ripcord-desktop-update-v1';
const DESKTOP_UPDATE_PUBLIC_KEYS: readonly string[] = updateSigningKeys.publicKeys;

type TSignedUpdate = {
	version: string;
	fileName: string;
	sha512: string;
	notesSha256: string;
	signature: string;
};

type TVerifyDownloadedUpdateInput = {
	info: unknown;
	filePath: string;
	publicKeys?: readonly string[];
	hashFile?: (filePath: string) => Promise<string>;
};

const readStringField = (value: unknown, key: string): string | undefined => {
	if (typeof value !== 'object' || value === null || !(key in value)) {
		return undefined;
	}

	const field: unknown = Reflect.get(value, key);
	if (typeof field !== 'string') {
		return undefined;
	}

	const trimmed = field.trim();
	return trimmed && !trimmed.includes('\n') ? trimmed : undefined;
};

const buildUpdateSignaturePayload = ({
	version,
	fileName,
	sha512,
	notesSha256,
}: Omit<TSignedUpdate, 'signature'>): string =>
	[
		UPDATE_SIGNATURE_PAYLOAD_HEADER,
		`version=${version}`,
		`file=${fileName}`,
		`sha512=${sha512}`,
		`notes-sha256=${notesSha256}`,
	].join('\n');

const resolveSignedUpdate = (info: unknown): TSignedUpdate | string => {
	if (typeof info !== 'object' || info === null) {
		return 'Update metadata is not an object.';
	}

	const version = readStringField(info, 'version');
	if (!version) {
		return 'Update metadata has no version.';
	}

	const signature = readStringField(info, UPDATE_SIGNATURE_FIELD);
	if (!signature) {
		return 'Update metadata has no Ripcord signature.';
	}

	// The signature does not cover these fields, so refuse metadata that uses
	// them: a web-installer package or an elevated (UAC) install.
	if (Reflect.get(info, 'packages') !== undefined) {
		return 'Update metadata must not list web-installer packages.';
	}

	// Exactly one file, so electron-updater cannot pick a different entry than
	// the one checked here (it matches installers by URL path, not raw string).
	const files: unknown = Reflect.get(info, 'files');
	if (!Array.isArray(files) || files.length !== 1) {
		return 'Update metadata must list exactly one installer.';
	}

	const [installer] = files;
	const fileName = readStringField(installer, 'url');
	const sha512 = readStringField(installer, 'sha512');
	if (!fileName?.toLowerCase().endsWith('.exe') || !sha512) {
		return 'Update metadata has an incomplete installer entry.';
	}

	if (Reflect.get(installer, 'isAdminRightsRequired') === true) {
		return 'Update metadata must not require an elevated install.';
	}

	const notes: unknown = Reflect.get(info, RELEASE_NOTES_FIELD);
	if (notes !== undefined && typeof notes !== 'string') {
		return 'Update metadata has malformed release notes.';
	}
	const notesSha256 = notes === undefined ? '' : createHash('sha256').update(notes, 'utf8').digest('hex');

	return { version, fileName, sha512, notesSha256, signature };
};

const verifyUpdateSignature = (update: TSignedUpdate, publicKeys: readonly string[]): boolean => {
	const payload = Buffer.from(buildUpdateSignaturePayload(update), 'utf8');
	const signature = Buffer.from(update.signature, 'base64');

	return publicKeys.some((publicKey) => {
		try {
			const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
			return verify(null, payload, key, signature);
		} catch {
			return false;
		}
	});
};

const hashFileSha512 = (filePath: string): Promise<string> =>
	new Promise((resolve, reject) => {
		const hash = createHash('sha512');
		createReadStream(filePath)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('base64')));
	});

// Returns null when the update metadata carries a valid signature from a
// trusted key, otherwise a reason. Checked before downloading so a cached
// installer (which electron-updater reuses without calling the signature hook,
// after re-hashing it against this metadata) is covered too.
const verifyUpdateMetadata = (
	info: unknown,
	publicKeys: readonly string[] = DESKTOP_UPDATE_PUBLIC_KEYS,
): string | null => {
	const update = resolveSignedUpdate(info);
	if (typeof update === 'string') {
		return update;
	}

	return verifyUpdateSignature(update, publicKeys) ? null : 'Update signature does not match a trusted Ripcord key.';
};

// Returns null when the downloaded installer is the exact file the signed
// metadata describes, otherwise a reason. electron-updater treats any reason as
// ERR_UPDATER_INVALID_SIGNATURE and deletes the download.
const verifyDownloadedUpdate = async ({
	info,
	filePath,
	publicKeys = DESKTOP_UPDATE_PUBLIC_KEYS,
	hashFile = hashFileSha512,
}: TVerifyDownloadedUpdateInput): Promise<string | null> => {
	const update = resolveSignedUpdate(info);
	if (typeof update === 'string') {
		return update;
	}

	if (!verifyUpdateSignature(update, publicKeys)) {
		return 'Update signature does not match a trusted Ripcord key.';
	}

	const actualSha512 = await hashFile(filePath);
	if (actualSha512 !== update.sha512) {
		return 'Downloaded installer does not match its signed hash.';
	}

	return null;
};

export { buildUpdateSignaturePayload, verifyDownloadedUpdate, verifyUpdateMetadata };
