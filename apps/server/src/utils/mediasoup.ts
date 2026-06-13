import mediasoup from 'mediasoup';
import { config, SERVER_PUBLIC_IPS } from '../config.js';
import { bootLog } from '../helpers/boot-log.js';
import { MEDIASOUP_BINARY_PATH } from '../helpers/paths.js';
import { logger } from '../logger.js';
import { IS_PRODUCTION } from './env.js';
import { buildWebRtcListenInfos, getPrimaryWebRtcListenInfo, type TWebRtcListenInfo } from './webrtc-listen-info.js';

let mediaSoupWorker: mediasoup.types.Worker<mediasoup.types.AppData>;
let webRtcServer: mediasoup.types.WebRtcServer<mediasoup.types.AppData>;
let webRtcServerListenInfo: { ip: string; announcedAddress?: string };
let webRtcServerListenInfos: TWebRtcListenInfo[] = [];

const getWebRtcPort = () => {
	const envPort = Number.parseInt(process.env.SHARKORD_WEBRTC_PORT || '', 10);

	if (Number.isInteger(envPort) && envPort > 0) {
		return envPort;
	}

	return +config.webRtc.port;
};

const loadMediasoup = async () => {
	const port = getWebRtcPort();

	const workerConfig: mediasoup.types.WorkerSettings = {
		logLevel: config.server.debug ? 'debug' : 'warn',
		disableLiburing: true,
		workerBin: MEDIASOUP_BINARY_PATH,
	};

	logger.debug(`Loading mediasoup worker with config ${JSON.stringify(workerConfig, null, 2)}`);

	// Deliberately a single worker. mediasoup workers are single-threaded, so a
	// worker pool (one per core, channels pinned to a worker — no pipeTransport
	// needed since consumption is always within a channel) would lift the
	// one-core media ceiling. That's a scaling change we don't need at current
	// load; revisit if concurrent voice throughput becomes CPU-bound on one core.
	bootLog('mediasoup: creating worker');
	mediaSoupWorker = await mediasoup.createWorker(workerConfig);
	bootLog('mediasoup: worker created');

	mediaSoupWorker.on('died', (error) => {
		logger.error('Mediasoup worker died', error);

		setTimeout(() => process.exit(1), 2000);
	});

	logger.debug('Mediasoup worker loaded');

	bootLog('mediasoup: building WebRTC listen infos');
	const listenInfos = buildWebRtcListenInfos(
		{ ...config.webRtc, port },
		{
			isProduction: IS_PRODUCTION,
			publicIps: SERVER_PUBLIC_IPS,
		},
	);

	if (listenInfos.length === 0) {
		throw new Error('No WebRTC listeners could be created. Configure at least one valid IPv4 or IPv6 WebRTC listener.');
	}

	bootLog('mediasoup: creating WebRTC server');
	webRtcServer = await mediaSoupWorker.createWebRtcServer({
		listenInfos,
	});
	bootLog('mediasoup: WebRTC server created');

	webRtcServerListenInfos = listenInfos;

	const primaryListenInfo = getPrimaryWebRtcListenInfo(listenInfos);

	if (!primaryListenInfo) {
		throw new Error('Primary WebRTC listen info could not be resolved');
	}

	webRtcServerListenInfo = primaryListenInfo;

	logger.debug(`WebRtcServer created with listenInfos ${JSON.stringify(listenInfos, null, 2)}`);
};

export { loadMediasoup, mediaSoupWorker, webRtcServer, webRtcServerListenInfo, webRtcServerListenInfos };
