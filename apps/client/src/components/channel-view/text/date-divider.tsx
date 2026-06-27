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
		<div className="relative flex select-none items-center justify-center py-2" role="separator" aria-label={label}>
			<span aria-hidden className="absolute inset-x-2 h-px bg-border" />
			<span className="relative bg-background px-2 text-xs font-semibold text-muted-foreground">{label}</span>
		</div>
	);
});

export { DateDivider };
