import { format, isToday, isYesterday } from 'date-fns';
import { memo, useMemo } from 'react';

type TDateDividerProps = {
	date: Date;
};

const getLabel = (date: Date): string => {
	if (isToday(date)) return 'Today';
	if (isYesterday(date)) return 'Yesterday';

	return format(date, 'MMMM d, yyyy');
};

const DateDivider = memo(({ date }: TDateDividerProps) => {
	const label = useMemo(() => getLabel(date), [date]);

	return (
		<div className="flex select-none items-center gap-3 px-2 py-2">
			<span aria-hidden className="h-px flex-1 bg-border" />
			<span className="shrink-0 text-xs font-semibold text-muted-foreground">{label}</span>
			<span aria-hidden className="h-px flex-1 bg-border" />
		</div>
	);
});

export { DateDivider };
