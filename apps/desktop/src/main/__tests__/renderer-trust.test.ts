import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isTrustedRendererUrl, resolveTrustedRendererUrl } from '../renderer-trust';

const packagedIndexPath = path.resolve('/tmp/ripcord/resources/app.asar/renderer-dist/index.html');

void describe('isTrustedRendererUrl', () => {
	void it('trusts the packaged renderer index file', () => {
		assert.equal(
			isTrustedRendererUrl(pathToFileURL(packagedIndexPath).toString(), {
				packagedIndexPath,
			}),
			true,
		);
	});

	void it('trusts packaged renderer index hash and query urls', () => {
		const base = pathToFileURL(packagedIndexPath).toString();

		assert.equal(isTrustedRendererUrl(`${base}#settings`, { packagedIndexPath }), true);
		assert.equal(isTrustedRendererUrl(`${base}?panel=voice`, { packagedIndexPath }), true);
	});

	void it('rejects other packaged file urls', () => {
		const otherUrl = pathToFileURL(path.resolve('/tmp/ripcord/resources/app.asar/renderer-dist/other.html')).toString();

		assert.equal(isTrustedRendererUrl(otherUrl, { packagedIndexPath }), false);
	});

	void it('rejects file urls when a dev renderer origin is configured', () => {
		assert.equal(
			isTrustedRendererUrl(pathToFileURL(packagedIndexPath).toString(), {
				packagedIndexPath,
				rendererUrl: 'http://localhost:5173',
			}),
			false,
		);
	});

	void it('trusts same-origin dev renderer urls', () => {
		assert.equal(
			isTrustedRendererUrl('http://localhost:5173/debug?panel=voice', {
				packagedIndexPath,
				rendererUrl: 'http://localhost:5173',
			}),
			true,
		);
	});

	void it('rejects non-local configured dev renderer origins', () => {
		assert.equal(
			isTrustedRendererUrl('https://preview.example.com/debug', {
				packagedIndexPath,
				rendererUrl: 'https://preview.example.com',
			}),
			false,
		);
	});

	void it('rejects lookalike dev origins', () => {
		assert.equal(
			isTrustedRendererUrl('http://localhost.evil.example:5173', {
				packagedIndexPath,
				rendererUrl: 'http://localhost:5173',
			}),
			false,
		);
	});

	void it('rejects remote origins in packaged builds', () => {
		assert.equal(
			isTrustedRendererUrl('https://evil.example/index.html', {
				packagedIndexPath,
			}),
			false,
		);
		assert.equal(isTrustedRendererUrl('http://localhost:5173', { packagedIndexPath }), false);
	});

	void it('rejects unsafe and malformed urls', () => {
		assert.equal(isTrustedRendererUrl('javascript:alert(1)', { packagedIndexPath }), false);
		assert.equal(isTrustedRendererUrl('not a url', { packagedIndexPath }), false);
	});
});

void describe('resolveTrustedRendererUrl', () => {
	void it('allows local renderer urls for unpackaged development', () => {
		assert.equal(
			resolveTrustedRendererUrl({
				isPackaged: false,
				isPreview: false,
				rendererUrl: 'http://localhost:5173',
			}),
			'http://localhost:5173',
		);
	});

	void it('allows local renderer urls for packaged preview builds', () => {
		assert.equal(
			resolveTrustedRendererUrl({
				isPackaged: true,
				isPreview: true,
				rendererUrl: 'http://localhost:5173',
			}),
			'http://localhost:5173',
		);
	});

	void it('rejects renderer urls for packaged production builds', () => {
		assert.equal(
			resolveTrustedRendererUrl({
				isPackaged: true,
				isPreview: false,
				rendererUrl: 'http://localhost:5173',
			}),
			undefined,
		);
	});

	void it('rejects non-local renderer urls in development and preview builds', () => {
		assert.equal(
			resolveTrustedRendererUrl({
				isPackaged: false,
				isPreview: false,
				rendererUrl: 'https://preview.example.com',
			}),
			undefined,
		);
		assert.equal(
			resolveTrustedRendererUrl({
				isPackaged: true,
				isPreview: true,
				rendererUrl: 'https://preview.example.com',
			}),
			undefined,
		);
	});
});
