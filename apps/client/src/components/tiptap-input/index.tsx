import { EmojiPicker } from '@/components/emoji-picker';
import { Button } from '@/components/ui/button';
import { useCustomEmojis } from '@/features/server/emojis/hooks';
import { cn } from '@/lib/utils';
import type { TCommandInfo } from '@sharkord/shared';
import Emoji, { gitHubEmojis } from '@tiptap/extension-emoji';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Smile } from 'lucide-react';
import { memo, useEffect, useMemo, useRef } from 'react';
import {
  COMMANDS_STORAGE_KEY,
  CommandSuggestion
} from './plugins/command-suggestion';
import { SlashCommands } from './plugins/slash-commands-extension';
import { EmojiSuggestion } from './suggestions';
import type { TEmojiItem } from './types';

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
    variant = 'default'
  }: TTiptapInputProps) => {
    const readOnlyRef = useRef(readOnly);
    readOnlyRef.current = readOnly;

    const customEmojis = useCustomEmojis();

    const extensions = useMemo(() => {
      const exts = [
        StarterKit.configure({
          hardBreak: {
            HTMLAttributes: {
              class: 'hard-break'
            }
          }
        }),
        Emoji.configure({
          emojis: [...gitHubEmojis, ...customEmojis],
          enableEmoticons: true,
          suggestion: EmojiSuggestion,
          HTMLAttributes: {
            class: 'emoji-image'
          }
        })
      ];

      if (commands) {
        exts.push(
          SlashCommands.configure({
            commands,
            suggestion: CommandSuggestion
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          }) as any
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
        }
      },
      editorProps: {
        handleKeyDown: (_view, event) => {
          // block all input when readOnly
          if (readOnlyRef.current) {
            event.preventDefault();
            return true;
          }

          const suggestionElement = document.querySelector(
            '.tiptap-suggestion-menu'
          );
          const hasSuggestions =
            suggestionElement && document.body.contains(suggestionElement);

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
        handleDrop: () => readOnlyRef.current
      }
    });

    const handleEmojiSelect = (emoji: TEmojiItem) => {
      if (disabled || readOnly) return;

      if (emoji.shortcodes.length > 0) {
        editor?.chain().focus().setEmoji(emoji.shortcodes[0]).run();
      }
    };

    // keep emoji storage in sync with custom emojis from the store
    // this ensures newly added emojis appear in autocomplete without refreshing the app
    useEffect(() => {
      if (editor && editor.storage.emoji) {
        editor.storage.emoji.emojis = [...gitHubEmojis, ...customEmojis];
      }
    }, [editor, customEmojis]);

    // keep commands storage in sync with plugin commands from the store
    useEffect(() => {
      if (editor && commands) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    return (
      <div
        className={cn(
          'flex min-w-0 flex-1 items-center',
          isChatComposer ? 'gap-1' : 'gap-2'
        )}
      >
        <EditorContent
          editor={editor}
          className={cn(
            'tiptap w-full overflow-auto',
            isChatComposer
              ? 'min-h-[38px] max-h-[7rem] rounded-md pl-1 pr-2 py-1.5 text-[15px] [&_.ProseMirror]:min-h-[22px] [&_.ProseMirror]:break-words [&_.ProseMirror]:leading-5 [&_.ProseMirror]:outline-none'
              : 'min-h-[40px] max-h-[5rem] rounded border p-2',
            disabled &&
              (isChatComposer
                ? 'opacity-50 cursor-not-allowed'
                : 'opacity-50 cursor-not-allowed bg-muted')
          )}
        />

        <EmojiPicker onEmojiSelect={handleEmojiSelect}>
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            className={cn(
              isChatComposer &&
                'h-8 w-8 text-muted-foreground hover:text-foreground'
            )}
          >
            <Smile className="h-5 w-5" />
          </Button>
        </EmojiPicker>
      </div>
    );
  }
);

export { TiptapInput };
