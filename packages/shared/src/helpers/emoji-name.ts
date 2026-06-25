import z from "../zod";

export const EMOJI_NAME_MIN = 2;
export const EMOJI_NAME_MAX = 32;

// Discord-style emoji names: lowercase letters, numbers, and underscores only.
export const EMOJI_NAME_REGEX = /^[a-z0-9_]+$/;

// A single allowed emoji-name character: lowercase letter, digit, or underscore.
const isEmojiNameChar = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";

export const EMOJI_NAME_ERROR =
  "Emoji names can only contain lowercase letters, numbers, and underscores.";

export const emojiNameSchema = z
  .string()
  .min(EMOJI_NAME_MIN, `Emoji names must be at least ${EMOJI_NAME_MIN} characters.`)
  .max(EMOJI_NAME_MAX, `Emoji names must be at most ${EMOJI_NAME_MAX} characters.`)
  .regex(EMOJI_NAME_REGEX, EMOJI_NAME_ERROR);

// Live input filter: lowercases and coerces any invalid character to an
// underscore, but preserves underscores the user is mid-way through typing
// (including leading/trailing ones). Use this on every keystroke.
export const toEmojiNameChars = (raw: string): string => {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, EMOJI_NAME_MAX);
};

// Coerces arbitrary text (e.g. a filename) into a tidy emoji-name default,
// collapsing invalid runs and trimming surrounding underscores. Does not pad
// short results — callers decide how to handle a name shorter than
// EMOJI_NAME_MIN.
export const sanitizeEmojiName = (raw: string): string => {
  // Single linear pass: lowercase, collapse runs of invalid characters into a
  // single underscore, and preserve underscores already present in the input.
  // Done without regex to avoid the polynomial-ReDoS backtracking CodeQL flags
  // on anchored `_+` patterns (js/polynomial-redos).
  let collapsed = "";
  let collapsing = false;
  for (const c of raw.toLowerCase()) {
    if (isEmojiNameChar(c)) {
      collapsed += c;
      collapsing = false;
    } else if (!collapsing) {
      collapsed += "_";
      collapsing = true;
    }
  }
  // Trim leading/trailing underscores, then cap at EMOJI_NAME_MAX.
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === "_") start++;
  while (end > start && collapsed[end - 1] === "_") end--;
  return collapsed.slice(start, Math.min(end, start + EMOJI_NAME_MAX));
};
