import { describe, expect, test } from 'bun:test';
import { getMessageTextLength } from '../message-length';

describe('message text length', () => {
	test('counts decoded entities and Unicode code points', () => {
		expect(getMessageTextLength('&amp;&nbsp;&#x1f600;😀')).toBe(4);
	});

	test('ignores markup and counts each image once', () => {
		expect(getMessageTextLength('<p>a<strong>b</strong></p><p>c<br></p>')).toBe(3);
		expect(getMessageTextLength('<p><img data-type="emoji" src="/emoji.png"></p>')).toBe(1);
	});

	test('ignores script, style, template and noscript content', () => {
		expect(
			getMessageTextLength(
				'<script>abc</script><style>abc</style><template>abc<img></template><noscript>abc</noscript><p>x</p>',
			),
		).toBe(1);
	});
});
