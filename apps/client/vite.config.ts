import path from 'node:path';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import pkg from './package.json';

const appVersion = process.env.SHARKORD_VERSION || pkg.version;
const shouldUploadSentrySourceMaps = Boolean(
	process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		react(),
		tailwindcss(),
		shouldUploadSentrySourceMaps
			? sentryVitePlugin({
					authToken: process.env.SENTRY_AUTH_TOKEN,
					org: process.env.SENTRY_ORG,
					project: process.env.SENTRY_PROJECT,
					release: {
						name: appVersion,
						setCommits: false,
					},
					sourcemaps: {
						assets: ['./dist/**/*.js', './dist/**/*.map'],
					},
				})
			: undefined,
	],
	build: {
		target: 'esnext',
		sourcemap: true,
		rollupOptions: {
			onwarn(warning, defaultHandler) {
				if (
					warning.plugin === '@tailwindcss/vite:generate:build' &&
					warning.message.includes('Sourcemap is likely to be incorrect')
				) {
					return;
				}
				defaultHandler(warning);
			},
		},
	},
	resolve: {
		alias: {
			'@': path.resolve(__dirname, './src'),
		},
	},
	define: {
		VITE_APP_VERSION: JSON.stringify(appVersion),
	},
});
