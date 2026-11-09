import { type DefaultTreeAdapterMap, parseFragment } from 'parse5';

const MESSAGE_MAX_TEXT_LENGTH = 4000;
const MESSAGE_MAX_HTML_LENGTH = 40_000;
const IGNORED_CONTENT_TAGS = new Set(['script', 'style', 'template', 'noscript']);

const getMessageTextLength = (html: string): number => {
	const stack: DefaultTreeAdapterMap['childNode'][] = [...parseFragment(html).childNodes];
	let length = 0;

	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;

		if ('tagName' in node) {
			if (IGNORED_CONTENT_TAGS.has(node.tagName)) continue;
			if (node.tagName === 'img') length += 1;
		}

		if ('nodeName' in node && node.nodeName === '#text' && 'value' in node) {
			length += [...node.value].length;
		}

		if ('childNodes' in node) {
			stack.push(...node.childNodes);
		}
	}

	return length;
};

export { getMessageTextLength, MESSAGE_MAX_HTML_LENGTH, MESSAGE_MAX_TEXT_LENGTH };
