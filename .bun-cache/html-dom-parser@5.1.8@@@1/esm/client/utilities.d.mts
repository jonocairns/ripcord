import type { DOMNode } from '../types.mjs';
/**
 * Formats DOM attributes to a hash map.
 *
 * @param attributes - List of attributes.
 * @returns - Map of attribute name to value.
 */
export declare function formatAttributes(attributes: NamedNodeMap): Record<string, string>;
/**
 * Checks if an HTML string contains an opening tag (case-insensitive).
 *
 * @param html - HTML string.
 * @param tagName - Tag name to search for (e.g., 'head' or 'body').
 * @returns - Whether the tag is found.
 */
export declare function hasOpenTag(html: string, tagName: string): boolean;
/**
 * Escapes special characters before parsing.
 *
 * @param html - The HTML string.
 * @returns - HTML string with escaped special characters.
 */
export declare function escapeSpecialCharacters(html: string): string;
/**
 * Reverts escaped special characters back to actual characters.
 *
 * @param text - The text with escaped characters.
 * @returns - Text with escaped characters reverted.
 */
export declare function revertEscapedCharacters(text: string): string;
/**
 * Transforms DOM nodes to `domhandler` nodes.
 *
 * @param nodes - DOM nodes.
 * @param parent - Parent node.
 * @param directive - Directive.
 * @returns - Nodes.
 */
export declare function formatDOM(nodes: NodeList, parent?: DOMNode | null, directive?: string): DOMNode[];
//# sourceMappingURL=utilities.d.mts.map