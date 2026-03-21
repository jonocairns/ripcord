const AVATAR_COLORS = [
	'bg-rose-600',
	'bg-orange-600',
	'bg-emerald-600',
	'bg-sky-600',
	'bg-violet-600',
	'bg-pink-600',
	'bg-indigo-600',
	'bg-teal-600',
] as const;

const getAvatarColor = (userId: number): string => {
	return AVATAR_COLORS[userId % AVATAR_COLORS.length];
};

export { getAvatarColor };
