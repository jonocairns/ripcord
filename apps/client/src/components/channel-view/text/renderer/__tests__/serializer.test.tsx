import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMessageHtml } from '../serializer';

const render = (content: string) => renderToStaticMarkup(<>{parseMessageHtml(content, () => {}, 1)}</>);

describe('parseMessageHtml', () => {
	test('renders allowed markup with safe link attributes', () => {
		const html = render(
			'<p><strong>bold</strong> <em>it</em> <code>x</code> <a href="https://example.com/page" target="_blank" rel="noopener">link</a></p>',
		);

		expect(html).toBe(
			'<p><strong>bold</strong> <em>it</em> <code>x</code> <a href="https://example.com/page" target="_blank" rel="noopener noreferrer">link</a></p>',
		);
	});

	test('drops styling classes from stored messages', () => {
		const html = render(
			'<span class="fixed inset-0 z-50 bg-black">x</span><br class="hard-break"><pre class="fixed"><code class="language-js">y</code></pre><img class="fixed inset-0 w-screen h-screen z-50" src="https://a.example/p.png"/>',
		);

		expect(html).not.toContain('class=');
		expect(html).toContain('<span>x</span><br/><pre><code>y</code></pre>');
		expect(html).toContain('<img src="https://a.example/p.png"/>');
	});

	test('replaces unsafe link attributes from stored messages', () => {
		expect(render('<a href="https://ok.example" target="_top" rel="opener">x</a>')).toBe(
			'<a href="https://ok.example" target="_blank" rel="noopener noreferrer">x</a>',
		);
	});

	test('does not render an iframe smuggled out of a legacy command attribute', () => {
		const html = render(
			`<command data-args='[{"value":"x'><iframe srcdoc=&lt;script&gt;alert(1)&lt;/script&gt; ","status":"pending"}]' data-status='pending'></command>`,
		);

		expect(html).not.toContain('iframe');
		expect(html).not.toContain('script');
		expect(html).not.toContain('srcdoc');
	});

	test('unwraps tags outside the allowlist but keeps their text', () => {
		expect(render('<h1>Title</h1><ul><li>one</li></ul>')).toBe('Titleone');
	});

	test('drops the contents of script and style tags', () => {
		expect(render('<p>hi</p><script>alert(1)</script><style>p{}</style>')).toBe('<p>hi</p>');
	});

	test('strips attributes outside the allowlist', () => {
		const html = render('<img src="https://example.com/e.png" onerror="alert(1)" style="x"/>');

		expect(html).toContain('<img src="https://example.com/e.png"/>');
		expect(html).not.toContain('onerror');
		expect(html).not.toContain('style');
	});

	test('strips hrefs with disallowed schemes', () => {
		expect(render('<a href="javascript:alert(1)">x</a>')).toBe('<a target="_blank" rel="noopener noreferrer">x</a>');
	});

	test('treats prototype property names as unknown tags', () => {
		expect(render('<constructor>text</constructor>')).toBe('text');
	});
});
