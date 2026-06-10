import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyWindowOpenUrl } from '../window-open-policy';

void describe('classifyWindowOpenUrl', () => {
	void it('allows internal about:blank popout windows', () => {
		const result = classifyWindowOpenUrl('about:blank');

		assert.equal(result.action, 'allow');
		assert.equal(result.openExternal, false);
	});

	void it('allows about:blank urls with hash/query fragments', () => {
		const result = classifyWindowOpenUrl('about:blank#screen-share-1');

		assert.equal(result.action, 'allow');
		assert.equal(result.openExternal, false);
	});

	void it('denies and externalizes http and https urls', () => {
		const httpResult = classifyWindowOpenUrl('http://example.com');
		const httpsResult = classifyWindowOpenUrl('https://example.com');

		assert.equal(httpResult.action, 'deny');
		assert.equal(httpResult.openExternal, true);
		assert.equal(httpsResult.action, 'deny');
		assert.equal(httpsResult.openExternal, true);
	});

	void it('denies non-http schemes without opening external browser', () => {
		const fileResult = classifyWindowOpenUrl('file:///tmp/test');
		const javascriptResult = classifyWindowOpenUrl('javascript:alert(1)');

		assert.equal(fileResult.action, 'deny');
		assert.equal(fileResult.openExternal, false);
		assert.equal(javascriptResult.action, 'deny');
		assert.equal(javascriptResult.openExternal, false);
	});

	void it('denies malformed urls without opening external browser', () => {
		const result = classifyWindowOpenUrl('not-a-valid-url');

		assert.equal(result.action, 'deny');
		assert.equal(result.openExternal, false);
	});
});
