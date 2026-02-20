import { LoadingCard } from '@/components/ui/loading-card';
import { useAdminEmojis } from '@/features/server/admin/hooks';
import { uploadFiles } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { EmojiList } from './emoji-list';

const Emojis = memo(() => {
  const { emojis, refetch, loading } = useAdminEmojis();
  const openFilePicker = useFilePicker();

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

  if (loading) {
    return <LoadingCard className="h-[600px]" />;
  }

  return (
    <div className="space-y-4">
      <EmojiList
        emojis={emojis}
        uploadEmoji={uploadEmoji}
        isUploading={isUploading}
      />
    </div>
  );
});

export { Emojis };
