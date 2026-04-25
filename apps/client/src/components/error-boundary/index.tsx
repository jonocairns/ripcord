import * as Sentry from '@sentry/react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { getRuntimeTag } from '@/helpers/error-reporting/sentry-client';

type TErrorBoundaryProps = {
	children: ReactNode;
};

const fallback = () => (
	<div className="flex h-full min-h-screen w-full items-center justify-center bg-background p-6">
		<div className="flex max-w-md flex-col items-center gap-4 text-center">
			<h1 className="font-semibold text-foreground text-lg">Something went wrong</h1>
			<p className="text-muted-foreground text-sm">
				An unexpected error occurred. The issue has been reported. Reload to try again.
			</p>
			<Button onClick={() => window.location.reload()}>Reload</Button>
		</div>
	</div>
);

const ErrorBoundary = ({ children }: TErrorBoundaryProps) => (
	<Sentry.ErrorBoundary
		fallback={fallback}
		beforeCapture={(scope) => {
			scope.setTag('capture_source', 'react_error_boundary');
			scope.setTag('runtime', getRuntimeTag());
		}}
	>
		{children}
	</Sentry.ErrorBoundary>
);

export { ErrorBoundary };
