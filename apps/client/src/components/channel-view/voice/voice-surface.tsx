import { cva, type VariantProps } from 'class-variance-authority';
import { type ComponentPropsWithoutRef, forwardRef } from 'react';
import { cn } from '@/lib/utils';

const voiceSurfaceVariants = cva('rounded-2xl border border-white/8', {
	variants: {
		variant: {
			card: 'bg-[#171b20]/88 shadow-[0_10px_32px_rgb(0_0_0/0.38)]',
			dock: 'bg-[#171b20]/74 shadow-[0_18px_40px_rgb(0_0_0/0.28)] backdrop-blur-xl',
			controls: 'bg-[#171b20]/88 shadow-2xl backdrop-blur-xl',
		},
		clip: {
			true: 'overflow-hidden',
			false: '',
		},
	},
	defaultVariants: {
		variant: 'card',
		clip: true,
	},
});

type TVoiceSurfaceProps = ComponentPropsWithoutRef<'div'> & VariantProps<typeof voiceSurfaceVariants>;

const VoiceSurface = forwardRef<HTMLDivElement, TVoiceSurfaceProps>(({ className, variant, clip, ...props }, ref) => {
	return <div ref={ref} className={cn(voiceSurfaceVariants({ variant, clip }), className)} {...props} />;
});

VoiceSurface.displayName = 'VoiceSurface';

export { VoiceSurface };
