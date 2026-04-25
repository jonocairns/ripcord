import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { reportError } from '@/helpers/browser-logger';

type TErrorBoundaryProps = {
	children: ReactNode;
};

type TErrorBoundaryState = {
	hasError: boolean;
};

class ErrorBoundary extends Component<TErrorBoundaryProps, TErrorBoundaryState> {
	state: TErrorBoundaryState = { hasError: false };

	static getDerivedStateFromError(): TErrorBoundaryState {
		return { hasError: true };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		reportError('React render error', error, {
			componentStack: errorInfo.componentStack ?? undefined,
		});
	}

	render() {
		if (!this.state.hasError) {
			return this.props.children;
		}

		return (
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
	}
}

export { ErrorBoundary };
