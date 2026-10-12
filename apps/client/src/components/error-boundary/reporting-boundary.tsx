import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '@/helpers/browser-logger';
export class ReportingBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch(error: Error, info: ErrorInfo) {
		reportError('React render failed', error, { componentStack: info.componentStack });
	}
	render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
