import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { ReportingBoundary } from './reporting-boundary';

type TErrorBoundaryProps = {
	children: ReactNode;
};

const fallback = () => (
	<div className="flex min-h-0 flex-1 items-center justify-center bg-background p-6">
		<div className="flex max-w-md flex-col items-center gap-4 text-center">
			<h1 className="font-semibold text-foreground text-lg">Something went wrong</h1>
			<p className="text-muted-foreground text-sm">An unexpected error occurred. Reload to try again.</p>
			<Button onClick={() => window.location.reload()}>Reload</Button>
		</div>
	</div>
);

const ErrorBoundary = ({ children }: TErrorBoundaryProps) => (
	<ReportingBoundary fallback={fallback()}>{children}</ReportingBoundary>
);

export { ErrorBoundary };
