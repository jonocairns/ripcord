import { type AppRouter, StreamKind } from '@sharkord/shared';
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import { Device } from 'mediasoup-client';
import type { Consumer, Producer } from 'mediasoup-client/types';

const server = 'http://127.0.0.1:4993';
const auth = await fetch(`${server}/login`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ identity: 'ios-browser-peer', password: 'local-poc-only' }),
}).then((r) => r.json());
const socket = createWSClient({
	url: server.replace('http:', 'ws:'),
	connectionParams: { token: auth.token, clientInstanceId: 'ios-poc-browser-peer' },
});
const rpc = createTRPCClient<AppRouter>({ links: [wsLink({ client: socket })] });
const handshake = await rpc.others.handshake.query();
const joined = await rpc.others.joinServer.query({ handshakeHash: handshake.handshakeHash });
await rpc.users.update.mutate({ name: 'Desktop test peer', bannerColor: '#1123c9' });
const voiceChannel = joined.channels.find((channel) => channel.type === 'VOICE');
const textChannel = joined.channels.find((channel) => channel.type === 'TEXT');
if (!voiceChannel || !textChannel) throw new Error('Missing seeded POC channels');
const textChannelId = textChannel.id;
const bootstrap = await rpc.voice.join.mutate({
	channelId: voiceChannel.id,
	state: { micMuted: false, soundMuted: false },
});
const device = new Device();
await device.load({ routerRtpCapabilities: bootstrap.routerRtpCapabilities });
const send = device.createSendTransport(bootstrap.producerTransportParams);
const receive = device.createRecvTransport(bootstrap.consumerTransportParams);
send.on('connect', ({ dtlsParameters }, done, fail) => {
	rpc.voice.connectProducerTransport.mutate({ transportId: send.id, dtlsParameters }).then(done, fail);
});
receive.on('connect', ({ dtlsParameters }, done, fail) => {
	rpc.voice.connectConsumerTransport.mutate({ transportId: receive.id, dtlsParameters }).then(done, fail);
});
send.on('produce', ({ rtpParameters, appData }, done, fail) => {
	const kind = appData.streamKind;
	if (kind !== StreamKind.AUDIO && kind !== StreamKind.SCREEN && kind !== StreamKind.SCREEN_AUDIO) {
		fail(new Error('Unexpected fixture producer kind'));
		return;
	}
	rpc.voice.produce.mutate({ transportId: send.id, kind, rtpParameters }).then((id) => done({ id }), fail);
});
const audio = new AudioContext();
await audio.resume();
function tone(frequency: number) {
	const oscillator = audio.createOscillator();
	const gain = audio.createGain();
	gain.gain.value = 0.08;
	oscillator.frequency.value = frequency;
	const output = audio.createMediaStreamDestination();
	oscillator.connect(gain).connect(output);
	oscillator.start();
	const track = output.stream.getAudioTracks()[0];
	if (!track) throw new Error('Synthetic audio track missing');
	return track;
}
const microphone = await send.produce({ track: tone(330), appData: { streamKind: StreamKind.AUDIO } });
const screenAudio = await send.produce({ track: tone(660), appData: { streamKind: StreamKind.SCREEN_AUDIO } });
const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 360;
document.body.append(canvas);
const drawing = canvas.getContext('2d');
if (!drawing) throw new Error('Canvas unavailable');
let frame = 0;
setInterval(() => {
	drawing.fillStyle = 'rgb(17, 35, 201)';
	drawing.fillRect(0, 0, 640, 360);
	drawing.fillStyle = 'white';
	drawing.font = 'bold 36px sans-serif';
	drawing.fillText('Ripcord desktop → iPhone', 40, 150);
	drawing.fillRect((frame++ * 5) % 640, 230, 35, 35);
}, 50);
const screenTrack = canvas.captureStream(20).getVideoTracks()[0];
if (!screenTrack) throw new Error('Synthetic screen track missing');
let screen: Producer;
async function share(codecName: string) {
	if (screen) {
		await rpc.voice.closeProducer.mutate({ kind: StreamKind.SCREEN });
		screen.close();
	}
	const codec = device.rtpCapabilities.codecs?.find((c) => c.mimeType.toLowerCase() === codecName.toLowerCase());
	if (!codec) throw new Error(`Browser cannot encode ${codecName}`);
	screen = await send.produce({
		track: screenTrack,
		stopTracks: false,
		codec,
		appData: { streamKind: StreamKind.SCREEN },
	});
}
await share('video/VP8');
await rpc.voice.updateState.mutate({ sharingScreen: true });
const consumers = new Map<number, Consumer>();
async function consume(remoteId: number) {
	if (consumers.has(remoteId)) return;
	const params = await rpc.voice.consume.mutate({
		remoteId,
		kind: StreamKind.AUDIO,
		rtpCapabilities: device.rtpCapabilities,
		transportId: receive.id,
		paused: true,
	});
	const consumer = await receive.consume({
		id: params.consumerId,
		producerId: params.producerId,
		kind: 'audio',
		rtpParameters: params.consumerRtpParameters,
	});
	consumers.set(remoteId, consumer);
	const playback = document.createElement('audio');
	playback.autoplay = true;
	// Chromium's --disable-audio-output suppresses hardware output. Keep the
	// element unmuted so WebRTC actually decodes received audio for assertions.
	playback.srcObject = new MediaStream([consumer.track]);
	document.body.append(playback);
	consumer.on('transportclose', () => playback.remove());
	consumer.on('@close', () => playback.remove());
	await rpc.voice.resumeConsumer.mutate({ remoteId, kind: StreamKind.AUDIO, consumerId: consumer.id });
	await playback.play();
}
rpc.voice.onNewProducer.subscribe(undefined, {
	onData: (event) => {
		if (event.kind === 'audio') consume(event.remoteId).catch(console.error);
	},
});
rpc.voice.onProducerClosed.subscribe(undefined, {
	onData: (event) => {
		if (event.kind === 'audio') {
			consumers.get(event.remoteId)?.close();
			consumers.delete(event.remoteId);
		}
	},
});
const producers = await rpc.voice.getProducers.query();
for (const id of producers.remoteAudioIds) await consume(id);
const receivedMessages: string[] = [];
rpc.messages.onNew.subscribe(undefined, {
	onData: (message) => {
		if (message.content) receivedMessages.push(message.content);
	},
});

async function state() {
	let inboundAudioBytes = 0;
	let inboundAudioEnergy = 0;
	const inboundAudioReports: unknown[] = [];
	for (const consumer of consumers.values()) {
		const stats = await consumer.getStats();
		stats.forEach((stat) => {
			if (stat.type === 'inbound-rtp') {
				inboundAudioBytes += stat.bytesReceived || 0;
				inboundAudioEnergy += stat.totalAudioEnergy || 0;
				inboundAudioReports.push(stat);
			}
		});
	}
	let outboundAudioBytes = 0;
	for (const producer of [microphone, screenAudio]) {
		const stats = await producer.getStats();
		stats.forEach((stat) => {
			if (stat.type === 'outbound-rtp') outboundAudioBytes += stat.bytesSent || 0;
		});
	}
	return {
		ready: true,
		userId: joined.ownUserId,
		inboundAudioBytes,
		inboundAudioEnergy,
		inboundAudioReports,
		outboundAudioBytes,
		receivedMessages,
		screenCodec: screen.rtpParameters.codecs[0]?.mimeType,
		screenCodecParameters: screen.rtpParameters.codecs[0]?.parameters,
		availableVideoCodecs: device.rtpCapabilities.codecs?.filter((codec) => codec.kind === 'video'),
	};
}
async function command(action: string, value?: string) {
	if (action === 'message')
		return rpc.messages.send.mutate({
			channelId: textChannelId,
			content: `<p>${value || 'Hello from desktop peer'}</p>`,
			files: [],
		});
	if (action === 'codec') return share(value || 'video/VP8');
	throw new Error('Unknown fixture command');
}
Object.assign(window, { pocPeer: { state, command } });
const status = document.getElementById('status');
if (status) status.textContent = 'Ready: publishing synthetic voice, screen video, and screen audio.';
