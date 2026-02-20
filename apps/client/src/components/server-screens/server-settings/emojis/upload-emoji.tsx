import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Upload } from 'lucide-react';
import { memo } from 'react';

type TUploadEmojiProps = {
  uploadEmoji: () => void;
  isUploading: boolean;
};

const UploadEmoji = memo(({ uploadEmoji, isUploading }: TUploadEmojiProps) => {
  return (
    <Card className="border-dashed">
      <CardContent className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full text-3xl">
          😀
        </div>
        <h3 className="text-lg font-medium text-foreground">
          Upload Custom Emojis
        </h3>
        <p className="max-w-md text-sm text-muted-foreground">
          Select an emoji to edit or upload new ones to customize your server
        </p>
        <Button onClick={uploadEmoji} disabled={isUploading} className="mt-1">
          <Upload className="h-4 w-4 mr-2" />
          Upload Emoji
        </Button>
      </CardContent>
    </Card>
  );
});

export { UploadEmoji };
