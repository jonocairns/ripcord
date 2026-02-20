import { Button } from '@/components/ui/button';
import { getFileUrl } from '@/helpers/get-file-url';
import { uploadFile } from '@/helpers/upload-file';
import { useFilePicker } from '@/hooks/use-file-picker';
import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedPublicUser } from '@sharkord/shared';
import { Upload, X } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';

type TBannerManagerProps = {
  user: TJoinedPublicUser;
  hideHeader?: boolean;
};

const BannerManager = memo(({ user, hideHeader = false }: TBannerManagerProps) => {
  const openFilePicker = useFilePicker();

  const removeBanner = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      await trpc.users.changeBanner.mutate({ fileId: undefined });

      toast.success('Banner removed successfully!');
    } catch {
      toast.error('Could not remove banner. Please try again.');
    }
  }, []);

  const onBannerClick = useCallback(async () => {
    const trpc = getTRPCClient();

    try {
      const [file] = await openFilePicker('image/*');

      const temporaryFile = await uploadFile(file);

      if (!temporaryFile) {
        toast.error('Could not upload file. Please try again.');
        return;
      }

      await trpc.users.changeBanner.mutate({ fileId: temporaryFile.id });

      toast.success('Banner updated successfully!');
    } catch {
      toast.error('Could not update banner. Please try again.');
    }
  }, [openFilePicker]);

  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div className="space-y-1 md:min-h-16">
          <p className="text-sm font-medium">Banner</p>
          <p className="text-xs text-muted-foreground">
            Upload a wide image to personalize your profile header.
          </p>
        </div>
      )}

      <div className="space-y-3">
        <div className="relative">
          <button
            type="button"
            className="relative group h-24 w-full cursor-pointer overflow-hidden rounded-md border border-border/60 bg-muted/20"
            onClick={onBannerClick}
          >
            {user.banner ? (
              <img
                src={getFileUrl(user.banner)}
                alt="User Banner"
                className="h-full w-full object-cover transition-opacity group-hover:opacity-70"
              />
            ) : (
              <div className="h-full w-full transition-opacity group-hover:opacity-70" />
            )}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-md">
              <div className="bg-black/50 rounded-full p-3">
                <Upload className="h-6 w-6 text-white" />
              </div>
            </div>
          </button>

          {user.bannerId && (
            <Button
              type="button"
              size="icon-sm"
              variant="secondary"
              className="absolute top-2 right-2 h-7 w-7 rounded-full border border-border/60 bg-background/90 shadow-sm"
              onClick={removeBanner}
              aria-label="Remove banner"
              title="Remove banner"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

export { BannerManager };
