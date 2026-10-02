import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMessageHtml } from '../serializer';

const render = (content: string) => renderToStaticMarkup(<>{parseMessageHtml(content, () => {}, 1)}</>);

describe('parseMessageHtml', () => {
	test('renders sanitizer-allowed markup unchanged', () => {
		const html = render(
			'<p><strong>bold</strong> <em>it</em> <code>x</code> <a href="https://example.com/page" target="_blank" rel="noopener">link</a></p>',
		);

		expect(html).toBe(
			'<p><strong>bold</strong> <em>it</em> <code>x</code> <a href="https://example.com/page" target="_blank" rel="noopener">link</a></p>',
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
		expect(render('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
	});

	test('treats prototype property names as unknown tags', () => {
		expect(render('<constructor>text</constructor>')).toBe('text');
	});
});
