import { expect, type Page } from '@playwright/test';

type MicrophoneEndpoint = {
	trackId: string;
	peerConnectionIndex: number;
	rtpId: string;
	bytes: number;
	packets: number;
	nonConcealedSamples: number;
};

// These scenarios publish only microphone audio. Match live sender/receiver
// identities, and require received audio to be attached to the app's player.
const microphoneMediaStats = async (page: Page) =>
	page.evaluate(async () => {
		const inbound: MicrophoneEndpoint[] = [];
		const outbound: MicrophoneEndpoint[] = [];
		const playingTracks = new Set<string>();
		for (const audio of document.querySelectorAll('audio[data-user-id]')) {
			if (
				!(audio instanceof HTMLAudioElement) ||
				!(audio.srcObject instanceof MediaStream) ||
				audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
				audio.paused ||
				audio.muted ||
				audio.volume === 0
			) {
				continue;
			}
			for (const track of audio.srcObject.getAudioTracks()) playingTracks.add(track.id);
		}

		for (const [peerConnectionIndex, pc] of (window.__ripcordE2ePeerConnections ?? []).entries()) {
			if (pc.signalingState === 'closed') continue;
			for (const sender of pc.getSenders()) {
				const track = sender.track;
				if (track?.kind !== 'audio' || track.readyState !== 'live' || !track.enabled) continue;
				const report = await sender.getStats().catch(() => undefined);
				report?.forEach((stat) => {
					if (stat.type !== 'outbound-rtp' || stat.kind !== 'audio') return;
					outbound.push({
						trackId: track.id,
						peerConnectionIndex,
						rtpId: stat.id,
						bytes: stat.bytesSent ?? 0,
						packets: stat.packetsSent ?? 0,
						nonConcealedSamples: 0,
					});
				});
			}
			for (const receiver of pc.getReceivers()) {
				const track = receiver.track;
				if (track.kind !== 'audio' || track.readyState !== 'live' || !playingTracks.has(track.id)) continue;
				const report = await receiver.getStats().catch(() => undefined);
				report?.forEach((stat) => {
					if (
						stat.type !== 'inbound-rtp' ||
						stat.kind !== 'audio' ||
						stat.trackIdentifier !== track.id ||
						typeof stat.totalSamplesReceived !== 'number' ||
						typeof stat.concealedSamples !== 'number'
					) {
						return;
					}
					inbound.push({
						trackId: track.id,
						peerConnectionIndex,
						rtpId: stat.id,
						bytes: stat.bytesReceived ?? 0,
						packets: stat.packetsReceived ?? 0,
						// totalSamplesReceived includes locally synthesized concealment.
						nonConcealedSamples: stat.totalSamplesReceived - stat.concealedSamples,
					});
				});
			}
		}
		return { inbound, outbound };
	});

type MicrophoneFlow = MicrophoneEndpoint & {
	initialBytes: number;
	initialPackets: number;
	initialNonConcealedSamples: number;
};

const expectMicrophoneFlow = async (page: Page, direction: 'inbound' | 'outbound'): Promise<MicrophoneFlow> => {
	await expect.poll(async () => (await microphoneMediaStats(page))[direction].length, { timeout: 30_000 }).toBe(1);
	const baseline = (await microphoneMediaStats(page))[direction][0];
	if (!baseline) throw new Error(`No ${direction} microphone endpoint was available`);
	let observed: MicrophoneEndpoint | undefined;
	await expect
		.poll(
			async () => {
				const current = (await microphoneMediaStats(page))[direction].find(
					(endpoint) =>
						endpoint.trackId === baseline.trackId &&
						endpoint.peerConnectionIndex === baseline.peerConnectionIndex &&
						endpoint.rtpId === baseline.rtpId,
				);
				observed = current;
				return (
					current !== undefined &&
					current.bytes > baseline.bytes &&
					current.packets > baseline.packets &&
					(direction === 'outbound' || current.nonConcealedSamples > baseline.nonConcealedSamples)
				);
			},
			{ message: `${direction} microphone RTP and received samples to advance`, timeout: 30_000 },
		)
		.toBe(true);
	if (!observed) throw new Error(`No advancing ${direction} microphone endpoint was available`);
	return {
		...observed,
		initialBytes: baseline.bytes,
		initialPackets: baseline.packets,
		initialNonConcealedSamples: baseline.nonConcealedSamples,
	};
};

export { expectMicrophoneFlow, microphoneMediaStats };
