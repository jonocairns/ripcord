import { Card, CardContent } from '@/components/ui/card';
import { LoadingCard } from '@/components/ui/loading-card';
import { useAdminEmojis } from '@/features/server/admin/hooks';
import { uploadFiles } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import { Smile } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EmojiList } from './emoji-list';
import { UpdateEmoji } from './update-emoji';

const Emojis = memo(() => {
  const { emojis, refetch, loading } = useAdminEmojis();
  const openFilePicker = useFilePicker();

  const [selectedEmojiId, setSelectedEmojiId] = useState<number | undefined>(
    undefined
  );
  const [isUploading, setIsUploading] = useState(false);

  const uploadEmoji = useCallback(async () => {
    const files = await openFilePicker('image/*', true);

    if (!files || files.length === 0) return;

    setIsUploading(true);

    const trpc = getTRPCClient();

    try {
      const temporaryFiles = await uploadFiles(files);

      await trpc.emojis.add.mutate(
        temporaryFiles.map((f) => ({
          name: f.originalName.replace(/\.[^/.]+$/, '').slice(0, 32),
          fileId: f.id
        }))
      );

      refetch();
      toast.success('Emoji created');
    } catch (error) {
      console.error('Error uploading emoji:', error);

      toast.error('Failed to upload emoji');
    } finally {
      setIsUploading(false);
    }
  }, [openFilePicker, refetch]);

  const selectedEmoji = useMemo(
    () => emojis.find((e) => e.id === selectedEmojiId),
    [emojis, selectedEmojiId]
  );

  if (loading) {
    return <LoadingCard className="h-[600px]" />;
  }

  return (
    <div className="space-y-4">
      <EmojiList
        emojis={emojis}
        setSelectedEmojiId={(id) => setSelectedEmojiId(id)}
        selectedEmojiId={selectedEmojiId}
        uploadEmoji={uploadEmoji}
        isUploading={isUploading}
      />

      {selectedEmoji ? (
        <UpdateEmoji
          key={selectedEmoji.id}
          selectedEmoji={selectedEmoji}
          setSelectedEmojiId={setSelectedEmojiId}
          refetch={refetch}
        />
      ) : (
        <Card className="border-dashed">
          <CardContent className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-full">
              <Smile className="text-muted-foreground h-6 w-6" />
            </div>
            <p className="text-foreground text-base font-medium">
              Select an emoji to edit
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              Use the + button above to upload new emojis.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
});

export { Emojis };
