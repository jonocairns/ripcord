import { describe, expect, test } from 'bun:test';
import { isEmptyMessage } from '@sharkord/shared';
import { sanitizeMessageHtml } from '../sanitize-html';

describe('sanitizeMessageHtml', () => {
	test.each([
		['<span class="fixed inset-0 z-50 bg-black">x</span>', '<span>x</span>'],
		[
			'<img class="fixed inset-0 w-screen h-screen z-50" src="https://a.example/p.png" />',
			'<img src="https://a.example/p.png" />',
		],
		[
			'<br class="hard-break"><pre class="fixed"><code class="language-js">x</code></pre>',
			'<br /><pre><code>x</code></pre>',
		],
	])('strips styling classes from %s', (input, expected) => {
		expect(sanitizeMessageHtml(input)).toBe(expected);
	});

	test.each([
		'<span CLASS="fixed inset-0 z-50">x</span>',
		'<span ClAsS="fixed inset-0 z-50">x</span>',
		'<svg><span class="fixed inset-0 z-50">x</span></svg>',
	])('strips classes regardless of case or wrapper in %s', (input) => {
		expect(sanitizeMessageHtml(input).toLowerCase()).not.toContain('class');
	});

	test.each([
		'<a href="https://ok.example" rel="opener" target="_top">x</a>',
		'<a href="https://ok.example">x</a>',
	])('forces safe link attributes on %s', (input) => {
		const html = sanitizeMessageHtml(input);

		expect(html).toContain('href="https://ok.example"');
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).not.toContain('rel="opener"');
	});

	test('preserves emoji metadata while removing its class', () => {
		expect(sanitizeMessageHtml('<span data-type="emoji" data-name="smile" class="emoji-image">😄</span>')).toBe(
			'<span data-type="emoji" data-name="smile">😄</span>',
		);
	});

	test('keeps an empty editor paragraph empty after stripping its trailing break class', () => {
		expect(isEmptyMessage(sanitizeMessageHtml('<p><br class="ProseMirror-trailingBreak"></p>'))).toBe(true);
	});
});
