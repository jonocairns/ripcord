import { Parser } from "htmlparser2";

const MEDIA_TAGS = new Set(["img", "video", "audio", "iframe"]);

const hasClass = (className: string | undefined, target: string): boolean => {
  if (!className) return false;
  return className.split(/\s+/).some((name) => name === target);
};

const isEmptyMessage = (content: string | undefined | null): boolean => {
  if (!content) return true;

  let hasMedia = false;
  const textParts: string[] = [];

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const normalizedName = name.toLowerCase();

        if (
          normalizedName === "img" &&
          hasClass(attributes.class, "ProseMirror-separator")
        ) {
          return;
        }

        if (
          normalizedName === "br" &&
          hasClass(attributes.class, "ProseMirror-trailingBreak")
        ) {
          return;
        }

        if (MEDIA_TAGS.has(normalizedName)) {
          hasMedia = true;
        }
      },
      ontext(text) {
        textParts.push(text);
      },
    },
    { decodeEntities: true },
  );

  parser.write(content);
  parser.end();

  const cleaned = textParts
    .join("")
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00A0/g, " ")
    .trim();

  const hasText = cleaned.length > 0;

  return !hasText && !hasMedia;
};

export { isEmptyMessage };
