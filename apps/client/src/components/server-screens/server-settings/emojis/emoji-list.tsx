import type { TJoinedEmoji } from '@sharkord/shared';
import { Plus, Search } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmojiCard } from './emoji-card';

type TEmojiListProps = {
	emojis: TJoinedEmoji[];
	uploadEmoji: () => void;
	refetch: () => void;
};

const EmojiList = memo(({ emojis, uploadEmoji, refetch }: TEmojiListProps) => {
	const [search, setSearch] = useState('');

	const filteredEmojis = useMemo(() => {
		const sorted = [...emojis].sort((a, b) => b.createdAt - a.createdAt);

		if (!search) return sorted;

		return sorted.filter((emoji) => emoji.name.toLowerCase().includes(search.toLowerCase()));
	}, [emojis, search]);

	return (
		<Card className="w-full gap-4 py-4">
			<CardHeader className="gap-2 px-4">
				<div className="flex items-center justify-between">
					<CardTitle className="text-base">Emojis</CardTitle>
					<Button onClick={uploadEmoji} className="gap-2">
						<Plus className="h-4 w-4" />
						Upload emoji
					</Button>
				</div>
				<CardDescription>
					{emojis.length} {emojis.length === 1 ? 'emoji' : 'emojis'} &middot; click a name to rename
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
				{filteredEmojis.length === 0 ? (
					<div className="py-8 text-center text-sm text-muted-foreground">
						{search ? 'No emojis found' : 'No custom emojis yet'}
					</div>
				) : (
					<div className="grid max-h-[440px] grid-cols-[repeat(auto-fill,minmax(5.75rem,1fr))] gap-2.5 overflow-y-auto pr-1">
						{filteredEmojis.map((emoji) => (
							<EmojiCard key={emoji.id} emoji={emoji} refetch={refetch} />
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
});

export { EmojiList };
