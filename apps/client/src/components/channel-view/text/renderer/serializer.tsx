import {
	imageExtensions,
	MESSAGE_HTML_ALLOWED_ATTRIBUTES,
	MESSAGE_HTML_ALLOWED_SCHEMES,
	MESSAGE_HTML_DROPPED_CONTENT_TAGS,
} from '@sharkord/shared';
import parse, { type DOMNode, domToReact, Element, type HTMLReactParserOptions, Text } from 'html-react-parser';
import type { ReactNode } from 'react';
import { TwitterOverride } from '../overrides/twitter';
import { YoutubeOverride } from '../overrides/youtube';
import type { TFoundMedia } from './types';

const twitterRegex = /https:\/\/(twitter|x).com\/\w+\/status\/(\d+)/g;
const youtubeRegex = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;

const pickAllowedAttributes = (attribs: Record<string, string>, allowed: readonly string[]): Record<string, string> => {
	const picked: Record<string, string> = {};

	for (const name of allowed) {
		const value = attribs[name];

		if (value !== undefined) {
			picked[name] = value;
		}
	}

	return picked;
};

// relative hrefs can't carry a scheme, so only absolute ones need checking
const hasDisallowedScheme = (href: string): boolean => {
	if (!URL.canParse(href)) return false;

	const scheme = new URL(href).protocol.slice(0, -1);

	return !MESSAGE_HTML_ALLOWED_SCHEMES.includes(scheme);
};

const isRenderableNode = (node: Element['children'][number]): node is Element | Text =>
	node instanceof Element || node instanceof Text;

const serializer = (
	domNode: DOMNode,
	pushMedia: (media: TFoundMedia) => void,
	messageId: number,
	renderChildren: (nodes: DOMNode[]) => ReactNode,
) => {
	if (!(domNode instanceof Element)) return null;

	// own keys only, so tag names like `constructor` can't hit Object.prototype
	const allowedAttributes = Object.hasOwn(MESSAGE_HTML_ALLOWED_ATTRIBUTES, domNode.name)
		? MESSAGE_HTML_ALLOWED_ATTRIBUTES[domNode.name]
		: undefined;

	// stored content is untrusted: anything outside the sanitizer's allowlist must not
	// become live DOM, even for rows written before the server sanitized them.
	if (!allowedAttributes) {
		if (MESSAGE_HTML_DROPPED_CONTENT_TAGS.includes(domNode.name)) {
			return <></>;
		}

		return <>{renderChildren(domNode.children.filter(isRenderableNode))}</>;
	}

	// returning null below falls back to default rendering, which reads these attribs
	domNode.attribs = pickAllowedAttributes(domNode.attribs, allowedAttributes);

	if (domNode.name === 'a' && domNode.attribs.href !== undefined && hasDisallowedScheme(domNode.attribs.href)) {
		delete domNode.attribs.href;
	}

	try {
		if (domNode.name === 'a' && domNode.attribs.href !== undefined) {
			const href = domNode.attribs.href;

			if (!URL.canParse(href)) {
				return null;
			}

			const url = new URL(href);

			const isTweet = url.hostname.match(/(twitter|x).com/) && href.match(twitterRegex);
			const isYoutube = url.hostname.match(/(youtube.com|youtu.be)/) && href.match(youtubeRegex);

			const isImage = imageExtensions.some((ext) => href.endsWith(ext));

			if (isTweet) {
				const tweetId = href.match(twitterRegex)?.[0].split('/').pop();

				if (tweetId) {
					return <TwitterOverride tweetId={tweetId} />;
				}
			} else if (isYoutube) {
				const videoId = href.match(/^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/)?.[7];

				if (videoId) {
					return <YoutubeOverride videoId={videoId} />;
				}
			} else if (isImage) {
				pushMedia({ type: 'image', url: href });

				return;
			}
		}
	} catch (error) {
		console.error(`Error parsing DOM node for message ID ${messageId}:`, error);
	}

	return null;
};

const parseMessageHtml = (content: string, pushMedia: (media: TFoundMedia) => void, messageId: number) => {
	const options: HTMLReactParserOptions = {
		replace: (domNode) => serializer(domNode, pushMedia, messageId, (nodes) => domToReact(nodes, options)),
	};

	return parse(content, options);
};

export { parseMessageHtml };
