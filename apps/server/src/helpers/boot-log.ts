// Dependency-free boot progress logging.
//
// Writes straight to stdout (so it shows up in `docker logs`) and pulls in
// nothing else - critically NOT the winston logger, which imports config.ts and
// therefore cannot exist until config has finished evaluating. The boot path has
// top-level `await`s during module evaluation (e.g. public-IP discovery in
// config.ts) that run before any normal logging is available; if one of those
// hangs the container would otherwise produce zero output. These markers leave a
// breadcrumb trail so a stuck boot is visible in `docker logs` instead of silent.
const bootLog = (message: string): void => {
	if (process.env.NODE_ENV === 'test') return;

	process.stdout.write(`[boot] ${new Date().toISOString()} ${message}\n`);
};

export { bootLog };
