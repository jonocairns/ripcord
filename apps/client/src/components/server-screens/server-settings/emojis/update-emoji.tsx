import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getFileUrl } from '@/helpers/get-file-url';
import { parseTrpcErrors, type TTrpcErrors } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedEmoji } from '@sharkord/shared';
import { filesize } from 'filesize';
import { Trash2 } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Emoji } from './emoji';

type TUpdateEmojiProps = {
  selectedEmoji: TJoinedEmoji;
  setSelectedEmojiId: (id: number | undefined) => void;
  refetch: () => void;
};

const UpdateEmoji = memo(
  ({ selectedEmoji, setSelectedEmojiId, refetch }: TUpdateEmojiProps) => {
    const [name, setName] = useState(selectedEmoji.name);
    const [errors, setErrors] = useState<TTrpcErrors>({});

    const onDeleteEmoji = useCallback(async () => {
      const choice = await requestConfirmation({
        title: 'Delete Emoji',
        message: `Are you sure you want to delete this emoji? This action cannot be undone.`,
        confirmLabel: 'Delete'
      });

      if (!choice) return;

      const trpc = getTRPCClient();

      try {
        await trpc.emojis.delete.mutate({ emojiId: selectedEmoji.id });
        toast.success('Emoji deleted');
        refetch();
        setSelectedEmojiId(undefined);
      } catch {
        toast.error('Failed to delete emoji');
      }
    }, [selectedEmoji.id, refetch, setSelectedEmojiId]);

    const onUpdateEmoji = useCallback(async () => {
      const trpc = getTRPCClient();

      try {
        await trpc.emojis.update.mutate({ emojiId: selectedEmoji.id, name });
        toast.success('Emoji updated');
        refetch();
      } catch (error) {
        setErrors(parseTrpcErrors(error));
      }
    }, [name, selectedEmoji.id, refetch]);

    const onNameChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        setName(e.target.value);
        setErrors((prev) => ({ ...prev, name: undefined }));
      },
      []
    );

    return (
      <Card className="flex-1 gap-0 py-0">
        <CardHeader className="border-b py-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle>Edit Emoji</CardTitle>
              <CardDescription>
                Update the emoji name or remove it from the server.
              </CardDescription>
            </div>
            <Button
              size="icon"
              variant="ghost"
              onClick={onDeleteEmoji}
              title="Delete emoji"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex-1 space-y-6 overflow-y-auto py-6">
          <div className="bg-muted flex items-center gap-4 rounded-lg border p-4">
            <Emoji
              src={getFileUrl(selectedEmoji.file)}
              name={selectedEmoji.name}
              className="h-16 w-16"
            />
            <div className="min-w-0">
              <div className="font-medium">:{selectedEmoji.name}:</div>
              <div className="text-sm text-muted-foreground">
                {filesize(selectedEmoji.file.size)} • Uploaded by{' '}
                {selectedEmoji.user.name}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="emoji-name">Name</Label>
              <Input
                id="emoji-name"
                value={name}
                onChange={onNameChange}
                placeholder="Enter emoji name (no spaces or special characters)"
                error={errors.name}
              />
              <p className="text-xs text-muted-foreground">
                This emoji will be used as :{name || selectedEmoji.name}: in
                messages
              </p>
            </div>
          </div>
        </CardContent>
        <CardFooter className="border-t justify-end gap-2 py-4">
          <Button
            variant="outline"
            onClick={() => setSelectedEmojiId(undefined)}
          >
            Close
          </Button>
          <Button
            onClick={onUpdateEmoji}
            disabled={selectedEmoji.name === name}
          >
            Save Changes
          </Button>
        </CardFooter>
      </Card>
    );
  }
);

export { UpdateEmoji };
