import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import updateSigningKeys from '../update-signing-keys.json';
import { buildUpdateSignaturePayload, verifyDownloadedUpdate, verifyUpdateMetadata } from '../update-verification';

const FILE_NAME = 'Ripcord.Desktop.Setup.2.7.0.exe';
const SHA512 = 'c2hhNTEyLW9mLXRoZS1pbnN0YWxsZXI=';

const createKeys = () => {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
};

const signedInfo = (
	privateKey: ReturnType<typeof createKeys>['privateKey'],
	signed = { version: '2.7.0', fileName: FILE_NAME, sha512: SHA512 },
) => ({
	version: '2.7.0',
	files: [{ url: FILE_NAME, sha512: SHA512, size: 7 }],
	ripcordUpdateSignature: sign(null, Buffer.from(buildUpdateSignaturePayload(signed)), privateKey).toString('base64'),
});

const hashAs = (sha512: string) => async () => sha512;

void describe('buildUpdateSignaturePayload', () => {
	void it('matches the payload the release workflow signs', () => {
		assert.equal(
			buildUpdateSignaturePayload({ version: '2.7.0', fileName: 'Ripcord.Desktop.Setup.2.7.0.exe', sha512: 'abc==' }),
			'ripcord-desktop-update-v1\nversion=2.7.0\nfile=Ripcord.Desktop.Setup.2.7.0.exe\nsha512=abc==',
		);
	});
});

void describe('verifyDownloadedUpdate', () => {
	void it('accepts an installer signed by a trusted key whose hash matches', async () => {
		const keys = createKeys();
		const result = await verifyDownloadedUpdate({
			info: signedInfo(keys.privateKey),
			filePath: 'installer.exe',
			publicKeys: [createKeys().publicKey, keys.publicKey],
			hashFile: hashAs(SHA512),
		});

		assert.equal(result, null);
	});

	void it('rejects a downloaded file that differs from the signed hash', async () => {
		const keys = createKeys();
		const result = await verifyDownloadedUpdate({
			info: signedInfo(keys.privateKey),
			filePath: 'installer.exe',
			publicKeys: [keys.publicKey],
			hashFile: hashAs('dGFtcGVyZWQ='),
		});

		assert.match(result ?? '', /does not match its signed hash/);
	});

	void it('rejects a signature from an untrusted key', async () => {
		const result = await verifyDownloadedUpdate({
			info: signedInfo(createKeys().privateKey),
			filePath: 'installer.exe',
			publicKeys: [createKeys().publicKey],
			hashFile: hashAs(SHA512),
		});

		assert.match(result ?? '', /trusted Ripcord key/);
	});

	void it('rejects metadata whose version differs from what was signed', async () => {
		const keys = createKeys();
		const info = signedInfo(keys.privateKey, { version: '2.6.9', fileName: FILE_NAME, sha512: SHA512 });
		const result = await verifyDownloadedUpdate({
			info,
			filePath: 'installer.exe',
			publicKeys: [keys.publicKey],
			hashFile: hashAs(SHA512),
		});

		assert.match(result ?? '', /trusted Ripcord key/);
	});

	void it('rejects metadata without a signature or with more than one installer', async () => {
		const keys = createKeys();
		const { ripcordUpdateSignature: _signature, ...unsigned } = signedInfo(keys.privateKey);
		const twoInstallers = {
			...signedInfo(keys.privateKey),
			files: [
				{ url: FILE_NAME, sha512: SHA512 },
				{ url: 'Other.exe', sha512: SHA512 },
			],
		};

		for (const info of [unsigned, twoInstallers]) {
			const result = await verifyDownloadedUpdate({
				info,
				filePath: 'installer.exe',
				publicKeys: [keys.publicKey],
				hashFile: hashAs(SHA512),
			});
			assert.notEqual(result, null);
		}
	});

	void it('ships parseable Ed25519 public keys', () => {
		assert.ok(updateSigningKeys.publicKeys.length > 0);
		for (const publicKey of updateSigningKeys.publicKeys) {
			const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
			assert.equal(key.asymmetricKeyType, 'ed25519');
		}
	});
});

void describe('verifyUpdateMetadata', () => {
	void it('accepts signed metadata before anything is downloaded', () => {
		const keys = createKeys();
		assert.equal(verifyUpdateMetadata(signedInfo(keys.privateKey), [keys.publicKey]), null);
	});

	void it('rejects unsigned or re-signed metadata', () => {
		const keys = createKeys();
		const { ripcordUpdateSignature: _signature, ...unsigned } = signedInfo(keys.privateKey);

		assert.match(verifyUpdateMetadata(unsigned, [keys.publicKey]) ?? '', /no Ripcord signature/);
		assert.match(
			verifyUpdateMetadata(signedInfo(createKeys().privateKey), [keys.publicKey]) ?? '',
			/trusted Ripcord key/,
		);
	});

	void it('rejects fields the signature does not cover', () => {
		const keys = createKeys();
		const info = signedInfo(keys.privateKey);
		const withPackages = { ...info, packages: { x64: { path: 'evil.7z', sha512: SHA512 } } };
		const elevated = { ...info, files: [{ url: FILE_NAME, sha512: SHA512, isAdminRightsRequired: true }] };

		assert.match(verifyUpdateMetadata(withPackages, [keys.publicKey]) ?? '', /web-installer packages/);
		assert.match(verifyUpdateMetadata(elevated, [keys.publicKey]) ?? '', /elevated install/);
	});
});
