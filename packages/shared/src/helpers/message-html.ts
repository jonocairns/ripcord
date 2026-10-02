// the only markup a stored message may contain. the server sanitizer strips
// everything else on write, and the client renderer enforces the same list on
// read so rows written before (or around) the sanitizer can't become live DOM.
const MESSAGE_HTML_ALLOWED_ATTRIBUTES: Readonly<Partial<Record<string, readonly string[]>>> = {
	// basic text structure
	p: [],
	br: ['class'],
	// inline formatting
	strong: [],
	em: [],
	code: ['class'],
	pre: ['class'],
	// links
	a: ['href', 'target', 'rel'],
	// emoji (span wrapper + img fallback)
	span: ['data-type', 'data-name', 'class'],
	img: ['src', 'alt', 'draggable', 'loading', 'align', 'class'],
};

const MESSAGE_HTML_ALLOWED_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

// disallowed tags are unwrapped so their text survives, except these, whose
// contents are code or form state rather than readable text.
const MESSAGE_HTML_DROPPED_CONTENT_TAGS: readonly string[] = ['script', 'style', 'textarea', 'option', 'noscript'];

export { MESSAGE_HTML_ALLOWED_ATTRIBUTES, MESSAGE_HTML_ALLOWED_SCHEMES, MESSAGE_HTML_DROPPED_CONTENT_TAGS };
