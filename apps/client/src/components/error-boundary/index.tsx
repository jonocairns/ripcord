import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { reportReactError } from '@/helpers/browser-logger';

type TErrorBoundaryProps = {
	children: ReactNode;
};

type TErrorBoundaryState = {
	hasError: boolean;
};

// Mirrors @sentry/react's linking trick: synthesize an Error whose stack is the
// componentStack and attach it as `error.cause`. Sentry's grouping algorithm
// then treats render errors with the right hierarchy. Skip when cause is
// already set so we don't clobber user-provided causes.
const linkComponentStackAsCause = (error: Error, componentStack: string) => {
	if (error.cause !== undefined) {
		return;
	}

	const causeError = new Error(error.message);
	causeError.name = `React ErrorBoundary ${error.name}`;
	causeError.stack = componentStack;

	try {
		Object.defineProperty(error, 'cause', {
			value: causeError,
			writable: true,
			configurable: true,
		});
	} catch {
		// Frozen / host objects can refuse property definition; safe to skip.
	}
};

class ErrorBoundary extends Component<TErrorBoundaryProps, TErrorBoundaryState> {
	state: TErrorBoundaryState = { hasError: false };

	static getDerivedStateFromError(): TErrorBoundaryState {
		return { hasError: true };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		const componentStack = errorInfo.componentStack ?? undefined;

		if (componentStack) {
			linkComponentStackAsCause(error, componentStack);
		}

		reportReactError(error, componentStack);
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
