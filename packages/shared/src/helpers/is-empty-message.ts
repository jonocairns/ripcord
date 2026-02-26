import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';

const MEDIA_TAGS = new Set(['img', 'video', 'audio', 'iframe']);
const IGNORED_CONTENT_TAGS = new Set(['script', 'style', 'template', 'noscript']);

type TNode = DefaultTreeAdapterMap['childNode'];

const getClassList = (node: TNode): string[] => {
  if (!('attrs' in node) || !Array.isArray(node.attrs)) {
    return [];
  }

  const classAttr = node.attrs.find((attr) => attr.name === 'class');

  return classAttr?.value?.split(/\s+/).filter(Boolean) ?? [];
};

const getNodeFlags = (nodes: TNode[]): { hasText: boolean; hasMedia: boolean } => {
  let hasText = false;
  let hasMedia = false;
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;

    if ('value' in node && typeof node.value === 'string') {
      const normalizedText = node.value.replace(/\u00A0/g, ' ').trim();

      if (normalizedText.length > 0) {
        hasText = true;
      }

      continue;
    }

    if ('tagName' in node && typeof node.tagName === 'string') {
      const tagName = node.tagName.toLowerCase();
      const classList = getClassList(node);
      const isProseMirrorSeparator =
        tagName === 'img' && classList.includes('ProseMirror-separator');
      const isProseMirrorTrailingBreak =
        tagName === 'br' && classList.includes('ProseMirror-trailingBreak');

      if (isProseMirrorSeparator || isProseMirrorTrailingBreak) {
        continue;
      }

      if (MEDIA_TAGS.has(tagName)) {
        hasMedia = true;
      }

      if (IGNORED_CONTENT_TAGS.has(tagName)) {
        continue;
      }
    }

    if ('childNodes' in node && Array.isArray(node.childNodes)) {
      stack.push(...node.childNodes);
    }
  }

  return { hasText, hasMedia };
};

const isEmptyMessage = (content: string | undefined | null): boolean => {
  if (!content) return true;

  try {
    const fragment = parseFragment(content);
    const { hasText, hasMedia } = getNodeFlags(fragment.childNodes);

    return !hasText && !hasMedia;
  } catch {
    return content.replace(/\u00A0/g, ' ').trim().length === 0;
  }
};

export { isEmptyMessage };
