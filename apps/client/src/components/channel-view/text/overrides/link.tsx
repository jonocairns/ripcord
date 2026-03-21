import { ExternalLink } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';

type TLinkOverrideProps = {
	link: string;
	label?: string;
	className?: string;
};

const LinkOverride = memo(({ link, label, className }: TLinkOverrideProps) => {
	return (
		<div className={cn('flex items-center gap-1', className)}>
			<a href={link} target="_blank" rel="noreferrer" className="text-sm hover:underline text-primary/60">
				{label || link}
			</a>
			<ExternalLink size="0.8rem" />
		</div>
	);
});

export { LinkOverride };
