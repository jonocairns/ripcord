const isEmptyMessage = (content: string | undefined | null): boolean => {
  if (!content) return true;

  const contentWithoutPmPlaceholders = content
    .replace(/<img[^>]*ProseMirror-separator[^>]*>/gi, "")
    .replace(/<br[^>]*ProseMirror-trailingBreak[^>]*>/gi, "");

  // check if it has media (eg: emojis will be detected here)
  const hasMedia = /<(img|video|audio|iframe)\b/i.test(
    contentWithoutPmPlaceholders
  );

  const cleaned = contentWithoutPmPlaceholders
    // remove all remaining tags
    .replace(/<[^>]*>/g, "")
    // normalize spaces
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00A0/g, " ")
    .trim();

  const hasText = cleaned.length > 0;

  return !hasText && !hasMedia;
};

export { isEmptyMessage };
