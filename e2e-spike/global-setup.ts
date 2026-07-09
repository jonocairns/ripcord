import { execFileSync } from 'node:child_process';

// Playwright runs under Node, which can't open bun:sqlite. So we shell out to bun
// to seed the dedicated Owner-role e2e peer before the suite runs.
export default function globalSetup() {
	execFileSync('bun', ['run', 'helpers/seed-peer-cli.ts'], {
		cwd: __dirname,
		stdio: 'inherit',
	});
}
