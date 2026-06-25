import { emojiNameSchema, sanitizeEmojiName, toEmojiNameChars } from '@sharkord/shared';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { uploadFile } from '@/helpers/upload-file';
import { getTRPCClient } from '@/lib/trpc';
import type { TDialogBaseProps } from '../types';

type TCreateEmojiDialogProps = TDialogBaseProps & {
	files: File[];
	refetch: () => void;
};

const stripExtension = (fileName: string) => fileName.replace(/\.[^/.]+$/, '');

const CreateEmojiDialog = memo(({ isOpen, close, files, refetch }: TCreateEmojiDialogProps) => {
	const [names, setNames] = useState<string[]>(() => files.map((f) => sanitizeEmojiName(stripExtension(f.name))));
	const [errors, setErrors] = useState<(string | undefined)[]>(() => files.map(() => undefined));
	const [previews, setPreviews] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);

	// Create and revoke the object URLs in the same effect so React's dev
	// double-invoke (StrictMode) can't revoke a URL that's still rendered.
	useEffect(() => {
		const urls = files.map((file) => URL.createObjectURL(file));

		setPreviews(urls);

		return () => urls.forEach((url) => URL.revokeObjectURL(url));
	}, [files]);

	const onNameChange = useCallback((index: number, value: string) => {
		const filtered = toEmojiNameChars(value);

		setNames((prev) => prev.map((n, i) => (i === index ? filtered : n)));
		setErrors((prev) => prev.map((e, i) => (i === index ? undefined : e)));
	}, []);

	const onSubmit = useCallback(async () => {
		const nextErrors = names.map((name) => {
			const result = emojiNameSchema.safeParse(name);
			return result.success ? undefined : result.error.issues[0]?.message;
		});

		if (nextErrors.some(Boolean)) {
			setErrors(nextErrors);
			return;
		}

		setLoading(true);

		const trpc = getTRPCClient();

		try {
			const payload: { fileId: string; name: string }[] = [];

			for (let i = 0; i < files.length; i++) {
				const tempFile = await uploadFile(files[i]);

				// uploadFile surfaces its own error toast on failure.
				if (!tempFile) continue;

				payload.push({ fileId: tempFile.id, name: names[i] });
			}

			if (payload.length === 0) return;

			await trpc.emojis.add.mutate(payload);

			refetch();
			toast.success(payload.length === 1 ? 'Emoji created' : `${payload.length} emojis created`);
			close();
		} catch (error) {
			console.error('Error creating emoji:', error);
			toast.error('Failed to create emoji');
		} finally {
			setLoading(false);
		}
	}, [files, names, refetch, close]);

	return (
		<Dialog open={isOpen}>
			<DialogContent onInteractOutside={close} close={close}>
				<DialogHeader>
					<DialogTitle>{files.length === 1 ? 'Upload emoji' : `Upload ${files.length} emojis`}</DialogTitle>
				</DialogHeader>

				<div className="flex max-h-[420px] flex-col gap-4 overflow-y-auto py-1 pr-1">
					{files.map((file, index) => (
						<div key={`${file.name}-${index}`} className="flex items-start gap-3">
							<div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/40">
								{previews[index] ? <img src={previews[index]} alt="" className="h-full w-full object-contain" /> : null}
							</div>
							<div className="min-w-0 flex-1">
								<Group label="Name">
									<Input
										value={names[index]}
										onChange={(e) => onNameChange(index, e.target.value)}
										onEnter={onSubmit}
										error={errors[index]}
										maxLength={32}
										placeholder="emoji_name"
										autoFocus={index === 0}
									/>
								</Group>
							</div>
						</div>
					))}
				</div>

				<DialogFooter className="gap-2">
					<Button variant="ghost" onClick={close} disabled={loading}>
						Cancel
					</Button>
					<Button onClick={onSubmit} disabled={loading}>
						{files.length === 1 ? 'Create emoji' : 'Create emojis'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
});

export { CreateEmojiDialog };
