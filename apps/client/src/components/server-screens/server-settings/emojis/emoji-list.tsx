import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import Spinner from '@/components/ui/spinner';
import { getFileUrl } from '@/helpers/get-file-url';
import { cn } from '@/lib/utils';
import type { TJoinedEmoji } from '@sharkord/shared';
import { Plus, Search } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Emoji } from './emoji';

type TEmojiListProps = {
  emojis: TJoinedEmoji[];
  setSelectedEmojiId: (id: number) => void;
  selectedEmojiId: number | undefined;
  uploadEmoji: () => void;
  isUploading: boolean;
};

const EmojiList = memo(
  ({
    emojis,
    setSelectedEmojiId,
    selectedEmojiId,
    uploadEmoji,
    isUploading
  }: TEmojiListProps) => {
    const [search, setSearch] = useState('');

    const filteredEmojis = useMemo(() => {
      const sorted = [...emojis].sort((a, b) => b.createdAt - a.createdAt);

      if (!search) return sorted;

      return sorted.filter((emoji) =>
        emoji.name.toLowerCase().includes(search.toLowerCase())
      );
    }, [emojis, search]);

    return (
      <Card className="w-full gap-4 py-4">
        <CardHeader className="gap-2 px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Emojis</CardTitle>
            <Button
              size="icon"
              variant="ghost"
              onClick={uploadEmoji}
              disabled={isUploading}
              title="Upload emoji"
            >
              {isUploading ? (
                <Spinner size="xs" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          </div>
          <CardDescription>
            {emojis.length} {emojis.length === 1 ? 'emoji' : 'emojis'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search emojis..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="max-h-[320px] overflow-y-auto pr-1">
            {filteredEmojis.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {search ? 'No emojis found' : 'No custom emojis yet'}
              </div>
            ) : (
              <div className="grid grid-cols-6 gap-2">
                {filteredEmojis.map((emoji) => (
                  <Emoji
                    key={emoji.id}
                    src={getFileUrl(emoji.file)}
                    name={emoji.name}
                    onClick={() => setSelectedEmojiId(emoji.id)}
                    className={cn(
                      'h-full w-full border border-transparent',
                      selectedEmojiId === emoji.id &&
                        'bg-accent ring-primary ring-2'
                    )}
                  />
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
);

export { EmojiList };
