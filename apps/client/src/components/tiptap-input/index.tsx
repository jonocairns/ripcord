import type { TCommandInfo } from '@sharkord/shared';
import Emoji, { gitHubEmojis } from '@tiptap/extension-emoji';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Smile } from 'lucide-react';
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { EmojiPicker } from '@/components/emoji-picker';
import { Button } from '@/components/ui/button';
import { useCustomEmojis } from '@/features/server/emojis/hooks';
import { cn } from '@/lib/utils';
import { COMMANDS_STORAGE_KEY, CommandSuggestion } from './plugins/command-suggestion';
import { SlashCommands } from './plugins/slash-commands-extension';
import { EmojiSuggestion } from './suggestions';
import type { TEmojiItem } from './types';

// chat-composer text area renders at leading-5 (20px) with a 22px min-height for one
// line; a second line pushes scrollHeight well past that, so this threshold sits safely
// between the two without needing to measure a real single-line baseline on mount.
const CHAT_COMPOSER_SINGLE_LINE_MAX_HEIGHT = 28;

type TTiptapInputProps = {
	disabled?: boolean;
	readOnly?: boolean;
	value?: string;
	onChange?: (html: string) => void;
	onSubmit?: () => void;
	onCancel?: () => void;
	onTyping?: () => void;
	commands?: TCommandInfo[];
	variant?: 'chat-composer' | 'default';
	// chat-composer only: rendered in the fixed-height action row below the text area,
	// left and right of the emoji button, so they never move as the text grows.
	leadingAction?: ReactNode;
	trailingAction?: ReactNode;
};

const TiptapInput = memo(
	({
		value,
		onChange,
		onSubmit,
		onCancel,
		onTyping,
		disabled,
		readOnly,
		commands,
		variant = 'default',
		leadingAction,
		trailingAction,
	}: TTiptapInputProps) => {
		const readOnlyRef = useRef(readOnly);
		readOnlyRef.current = readOnly;

		const customEmojis = useCustomEmojis();

		const extensions = useMemo(() => {
			const exts = [
				StarterKit.configure({
					hardBreak: {
						HTMLAttributes: {
							class: 'hard-break',
						},
					},
				}),
				Emoji.configure({
					emojis: [...gitHubEmojis, ...customEmojis],
					enableEmoticons: true,
					suggestion: EmojiSuggestion,
					HTMLAttributes: {
						class: 'emoji-image',
					},
				}),
			];

			if (commands) {
				exts.push(
					SlashCommands.configure({
						commands,
						suggestion: CommandSuggestion,
					}) as any,
				);
			}

			return exts;
		}, [customEmojis, commands]);

		const editor = useEditor({
			extensions,
			content: value,
			editable: !disabled,
			onUpdate: ({ editor }) => {
				const html = editor.getHTML();

				onChange?.(html);

				if (!editor.isEmpty) {
					onTyping?.();
					return;
				}

				// clearing everything via select-all + delete leaves a non-collapsed
				// AllSelection over the empty paragraph, which the browser paints as a
				// stray blue selection bar. collapse it so the empty composer shows a
				// normal caret. deferred to avoid dispatching during the current update.
				if (!editor.state.selection.empty) {
					queueMicrotask(() => {
						if (!editor.isDestroyed && editor.isEmpty && !editor.state.selection.empty) {
							editor.commands.setTextSelection(1);
						}
					});
				}
			},
			editorProps: {
				handleKeyDown: (_view, event) => {
					// block all input when readOnly
					if (readOnlyRef.current) {
						event.preventDefault();
						return true;
					}

					const suggestionElement = document.querySelector('.tiptap-suggestion-menu');
					const hasSuggestions = suggestionElement && document.body.contains(suggestionElement);

					if (event.key === 'Enter') {
						if (event.shiftKey) {
							return false;
						}

						// if suggestions are active, don't handle Enter - let the suggestion handle it
						if (hasSuggestions) {
							return false;
						}

						event.preventDefault();
						onSubmit?.();
						return true;
					}

					if (event.key === 'Escape') {
						event.preventDefault();
						onCancel?.();
						return true;
					}

					return false;
				},
				handleClickOn: (_view, _pos, _node, _nodePos, event) => {
					const target = event.target as HTMLElement;

					// prevents clicking on links inside the edit from opening them in the browser
					if (target.tagName === 'A') {
						event.preventDefault();

						return true;
					}

					return false;
				},
				handlePaste: () => !!readOnlyRef.current,
				handleDrop: () => readOnlyRef.current,
			},
		});

		const handleEmojiSelect = (emoji: TEmojiItem) => {
			if (disabled || readOnly) return;

			if (emoji.shortcodes.length > 0) {
				editor?.chain().focus().setEmoji(emoji.shortcodes[0]).run();
			}
		};

		// keep emoji storage and extension options in sync with custom emojis.
		// storage drives the autocomplete suggestion popup; options.emojis drives
		// the `:shortcode:` input rule and the renderHTML lookup. without the
		// options sync, typing a custom emoji shortcode doesn't convert if the
		// custom emojis loaded after editor init.
		useEffect(() => {
			if (!editor) return;

			const merged = [...gitHubEmojis, ...customEmojis];

			if (editor.storage.emoji) {
				editor.storage.emoji.emojis = merged;
			}

			const emojiExtension = editor.extensionManager.extensions.find((ext) => ext.name === 'emoji');

			if (emojiExtension) {
				emojiExtension.options.emojis = merged;
			}
		}, [editor, customEmojis]);

		// keep commands storage in sync with plugin commands from the store
		useEffect(() => {
			if (editor && commands) {
				const storage = editor.storage as any;
				if (storage[COMMANDS_STORAGE_KEY]) {
					storage[COMMANDS_STORAGE_KEY].commands = commands;
				}
			}
		}, [editor, commands]);

		useEffect(() => {
			if (editor && value !== undefined) {
				const currentContent = editor.getHTML();

				// only update if content is actually different to avoid cursor jumping
				if (currentContent !== value) {
					editor.commands.setContent(value);
				}
			}
		}, [editor, value]);

		useEffect(() => {
			if (editor) {
				editor.setEditable(!disabled);
			}
		}, [editor, disabled]);

		const isChatComposer = variant === 'chat-composer';

		const [isMultiline, setIsMultiline] = useState(false);

		// Single line: text sits inline with the action buttons. Once it wraps to a
		// second line (hard break or natural word-wrap), the actions drop to their own
		// row below so they don't get squeezed by a growing text area — matches ChatGPT.
		useEffect(() => {
			if (!isChatComposer || !editor) return;

			const dom = editor.view.dom;

			const updateIsMultiline = () => {
				setIsMultiline(dom.scrollHeight > CHAT_COMPOSER_SINGLE_LINE_MAX_HEIGHT);
			};

			updateIsMultiline();

			const observer = new ResizeObserver(updateIsMultiline);
			observer.observe(dom);

			return () => observer.disconnect();
		}, [isChatComposer, editor]);

		const emojiButton = (
			<EmojiPicker onEmojiSelect={handleEmojiSelect}>
				<Button
					variant="ghost"
					size="icon"
					disabled={disabled}
					className={cn(isChatComposer && 'h-8 w-8 text-muted-foreground hover:text-foreground')}
				>
					<Smile className="h-5 w-5" />
				</Button>
			</EmojiPicker>
		);

		if (!isChatComposer) {
			return (
				<div className="flex min-w-0 flex-1 items-center gap-2">
					<EditorContent
						editor={editor}
						className={cn(
							'tiptap w-full overflow-auto min-h-[40px] max-h-[5rem] rounded border p-2',
							disabled && 'opacity-50 cursor-not-allowed bg-muted',
						)}
					/>
					{emojiButton}
				</div>
			);
		}

		// One tree shape for both single-line and multi-line: only classNames (order,
		// basis, margin) change based on isMultiline, never the element types or their
		// position in the tree. Branching into two different returns here would make React
		// unmount/remount the EditorContent subtree on every mode switch, dropping focus
		// and cursor position — flex-wrap + order lets the same elements just reflow.
		return (
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
				{leadingAction}
				<EditorContent
					editor={editor}
					className={cn(
						'tiptap overflow-auto min-h-[22px] max-h-[7rem] text-[15px] leading-5 [&_.ProseMirror]:min-h-[22px] [&_.ProseMirror]:break-words [&_.ProseMirror]:leading-5 [&_.ProseMirror]:outline-none',
						isMultiline ? 'order-first basis-full' : 'min-w-0 flex-1',
						disabled && 'opacity-50 cursor-not-allowed',
					)}
				/>
				<div className={cn('flex items-center gap-1', isMultiline && 'ml-auto')}>
					{emojiButton}
					{trailingAction}
				</div>
			</div>
		);
	},
);

export { TiptapInput };
