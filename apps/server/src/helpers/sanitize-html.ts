import {
	MESSAGE_HTML_ALLOWED_ATTRIBUTES,
	MESSAGE_HTML_ALLOWED_SCHEMES,
	MESSAGE_HTML_DROPPED_CONTENT_TAGS,
} from '@sharkord/shared';
import sanitize from 'sanitize-html';

const sanitizeMessageHtml = (html: string): string => {
	return sanitize(html, {
		allowedTags: Object.keys(MESSAGE_HTML_ALLOWED_ATTRIBUTES),
		allowedAttributes: {
			...MESSAGE_HTML_ALLOWED_ATTRIBUTES,
			'*': [],
		},
		allowedSchemes: [...MESSAGE_HTML_ALLOWED_SCHEMES],
		nonTextTags: [...MESSAGE_HTML_DROPPED_CONTENT_TAGS],
		// disallow any script or event handler attributes globally
		disallowedTagsMode: 'discard',
	});
};

export { sanitizeMessageHtml };
