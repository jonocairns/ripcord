import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { uploadFile } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedPublicUser } from '@sharkord/shared';
import { Upload, X } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TAvatarManagerProps = {
  user: TJoinedPublicUser;
};

const AvatarManager = memo(({ user }: TAvatarManagerProps) => {
  const openFilePicker = useFilePicker();

  const removeAvatar = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.users.changeAvatar.mutate({ fileId: undefined });

      toast.success('Avatar removed successfully!');
    } catch {
      toast.error('Could not remove avatar. Please try again.');
    }
  }, []);

  const onAvatarClick = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      const [file] = await openFilePicker('image/*');

      const temporaryFile = await uploadFile(file);

      if (!temporaryFile) {
        toast.error('Could not upload file. Please try again.');
        return;
      }

      await trpc.users.changeAvatar.mutate({ fileId: temporaryFile.id });

      toast.success('Avatar updated successfully!');
    } catch {
      toast.error('Could not update avatar. Please try again.');
    }
  }, [openFilePicker]);

  return (
    <div className="space-y-3">
      <div className="space-y-1 md:min-h-16">
        <p className="text-sm font-medium">Avatar</p>
        <p className="text-xs text-muted-foreground">
          Upload a new avatar image.
        </p>
      </div>

      <div className="flex flex-col items-start gap-3">
        <div className="relative">
          <button
            type="button"
            className="relative group h-24 w-24 cursor-pointer overflow-hidden rounded-full"
            onClick={onAvatarClick}
          >
            <UserAvatar
              userId={user.id}
              className="h-24 w-24 rounded-full bg-muted transition-opacity group-hover:opacity-30"
              showStatusBadge={false}
              showUserPopover={false}
            />
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-full">
              <div className="bg-black/50 rounded-full p-2">
                <Upload className="h-4 w-4 text-white" />
              </div>
            </div>
          </button>

          {user.avatarId && (
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              className="absolute -top-1 -right-1 h-7 w-7 rounded-full border border-border/60 bg-background/90 shadow-sm"
              onClick={removeAvatar}
              aria-label="Remove avatar"
              title="Remove avatar"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

export { AvatarManager };
