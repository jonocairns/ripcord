import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
	getDevRendererCspUrlPattern,
	isPackagedRendererFileUrl,
	PACKAGED_RENDERER_CSP,
	PACKAGED_RENDERER_CSP_HEADER,
	withPackagedRendererCspReportOnly,
} from '../renderer-csp';

void describe('isPackagedRendererFileUrl', () => {
	void it('matches packaged renderer files', () => {
		const rendererDistPath = path.resolve('renderer-dist');
		const fileUrl = pathToFileURL(path.join(rendererDistPath, 'assets', 'index.js')).toString();

		assert.equal(isPackagedRendererFileUrl(fileUrl, rendererDistPath), true);
	});

	void it('rejects file URLs outside renderer-dist', () => {
		const rendererDistPath = path.resolve('renderer-dist');
		const fileUrl = pathToFileURL(path.resolve('other', 'index.html')).toString();

		assert.equal(isPackagedRendererFileUrl(fileUrl, rendererDistPath), false);
	});

	void it('rejects non-file URLs', () => {
		assert.equal(isPackagedRendererFileUrl('https://example.com/index.html', '.'), false);
	});
});

void describe('getDevRendererCspUrlPattern', () => {
	void it('scopes the pattern to the dev renderer origin', () => {
		assert.equal(getDevRendererCspUrlPattern('http://localhost:5173'), 'http://localhost:5173/*');
	});

	void it('drops paths and trailing slashes from the dev renderer URL', () => {
		assert.equal(getDevRendererCspUrlPattern('http://localhost:5173/some/path/'), 'http://localhost:5173/*');
	});
});

void describe('withPackagedRendererCspReportOnly', () => {
	void it('adds the report-only CSP header without dropping existing headers', () => {
		const headers = withPackagedRendererCspReportOnly({
			'content-type': ['text/html'],
		});

		assert.deepEqual(headers['content-type'], ['text/html']);
		assert.deepEqual(headers[PACKAGED_RENDERER_CSP_HEADER], [PACKAGED_RENDERER_CSP]);
	});
});
