import { expect, type Page } from '@playwright/test';

declare global {
	interface Window {
		__ripcordE2eDisplayTracks?: MediaStreamTrack[];
		__ripcordE2eDisplayCaptureCalls?: number;
		__ripcordE2eScreenReceiverTracks?: MediaStreamTrack[];
		__ripcordE2eTransportGate?: { held: number; release: () => void };
	}
}

// An explicit acquisition mock, not browser/OS picker coverage. Only the screen
// spec installs it; everything after acquisition uses the real app and WebRTC.
const installScreenCapture = async (page: Page): Promise<void> => {
	await page.evaluate(() => {
		window.__ripcordE2eDisplayTracks = [];
		window.__ripcordE2eDisplayCaptureCalls = 0;
		navigator.mediaDevices.getDisplayMedia = async () => {
			window.__ripcordE2eDisplayCaptureCalls = (window.__ripcordE2eDisplayCaptureCalls ?? 0) + 1;
			const canvas = document.createElement('canvas');
			canvas.width = 640;
			canvas.height = 360;
			const context = canvas.getContext('2d');
			if (!context) throw new Error('Could not create screen fixture canvas');
			let frame = 0;
			const draw = () => {
				// A stable blue center identifies decoded screen frames independently
				// of Chromium's green fake webcam; movement keeps RTP flowing.
				context.fillStyle = 'rgb(17, 35, 201)';
				context.fillRect(0, 0, canvas.width, canvas.height);
				context.fillStyle = 'white';
				context.fillRect((frame++ * 8) % canvas.width, 20, 32, 32);
			};
			draw();
			const stream = canvas.captureStream(30);
			const track = stream.getVideoTracks()[0];
			if (!track) throw new Error('Screen fixture did not create a video track');
			window.__ripcordE2eDisplayTracks?.push(track);
			const interval = window.setInterval(draw, 33);
			const nativeStop = track.stop.bind(track);
			track.stop = () => {
				nativeStop();
				window.clearInterval(interval);
			};
			// No synthetic audio: display/system audio acquisition is an explicit gap.
			return stream;
		};
	});
};

type ScreenEndpoint = {
	trackId: string;
	peerConnectionIndex: number;
	bytes: number;
	frames: number;
	playbackFrames: number;
};

const screenMediaStats = async (page: Page): Promise<{ inbound: ScreenEndpoint[]; outbound: ScreenEndpoint[] }> =>
	page.evaluate(async () => {
		const inbound: ScreenEndpoint[] = [];
		const outbound: ScreenEndpoint[] = [];
		const displayTrackIds = new Set(window.__ripcordE2eDisplayTracks?.map((track) => track.id));
		const screenVideos = new Map<string, HTMLVideoElement>();
		const canvas = document.createElement('canvas');
		canvas.width = 1;
		canvas.height = 1;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Could not inspect decoded screen frames');
		for (const video of document.querySelectorAll('video')) {
			if (!(video.srcObject instanceof MediaStream) || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
				continue;
			}
			context.drawImage(video, video.videoWidth / 2, video.videoHeight / 2, 1, 1, 0, 0, 1, 1);
			const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
			if (Math.abs(red - 17) > 12 || Math.abs(green - 35) > 12 || Math.abs(blue - 201) > 12) continue;
			for (const track of video.srcObject.getVideoTracks()) {
				if (track.readyState === 'live') screenVideos.set(track.id, video);
			}
		}

		for (const [peerConnectionIndex, pc] of (window.__ripcordE2ePeerConnections ?? []).entries()) {
			if (pc.signalingState === 'closed') continue;
			for (const sender of pc.getSenders()) {
				const track = sender.track;
				if (track?.readyState !== 'live' || !displayTrackIds.has(track.id)) continue;
				const report = await sender.getStats().catch(() => undefined);
				if (!report) continue;
				let bytes = 0;
				let frames = 0;
				report.forEach((stat) => {
					if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
						bytes += stat.bytesSent ?? 0;
						frames += stat.framesEncoded ?? 0;
					}
				});
				outbound.push({ trackId: track.id, peerConnectionIndex, bytes, frames, playbackFrames: 0 });
			}
			for (const receiver of pc.getReceivers()) {
				const track = receiver.track;
				const video = screenVideos.get(track.id);
				if (!video || track.readyState !== 'live') continue;
				const report = await receiver.getStats().catch(() => undefined);
				if (!report) continue;
				let bytes = 0;
				let frames = 0;
				report.forEach((stat) => {
					if (stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.trackIdentifier === track.id) {
						bytes += stat.bytesReceived ?? 0;
						frames += stat.framesDecoded ?? 0;
					}
				});
				window.__ripcordE2eScreenReceiverTracks ??= [];
				if (!window.__ripcordE2eScreenReceiverTracks.includes(track)) {
					window.__ripcordE2eScreenReceiverTracks.push(track);
				}
				inbound.push({
					trackId: track.id,
					peerConnectionIndex,
					bytes,
					frames,
					playbackFrames: video.getVideoPlaybackQuality().totalVideoFrames,
				});
			}
		}
		return { inbound, outbound };
	});

const expectScreenFlow = async (page: Page, direction: 'inbound' | 'outbound'): Promise<ScreenEndpoint> => {
	await expect.poll(async () => (await screenMediaStats(page))[direction].length, { timeout: 40_000 }).toBe(1);
	const baseline = (await screenMediaStats(page))[direction][0];
	if (!baseline) throw new Error(`No ${direction} screen endpoint was available`);
	await expect
		.poll(
			async () => {
				const current = (await screenMediaStats(page))[direction].find(
					(endpoint) =>
						endpoint.trackId === baseline.trackId && endpoint.peerConnectionIndex === baseline.peerConnectionIndex,
				);
				return (
					current !== undefined &&
					current.bytes > baseline.bytes &&
					current.frames > baseline.frames &&
					(direction === 'outbound' || current.playbackFrames > baseline.playbackFrames)
				);
			},
			{ message: `${direction} screen RTP and frames to advance`, timeout: 40_000 },
		)
		.toBe(true);
	return baseline;
};

const screenIndicator = (page: Page) => page.locator('button:has(svg.sidebar-live-indicator--screen)');

const startScreenShare = async (page: Page): Promise<void> => {
	await page.getByTitle('Share screen', { exact: true }).click();
	await expect(page.getByTitle('Stop sharing', { exact: true })).toBeVisible();
	await expectScreenFlow(page, 'outbound');
};

const watchScreenShare = async (page: Page): Promise<ScreenEndpoint> => {
	await expect(screenIndicator(page)).toHaveCount(1);
	await screenIndicator(page).click();
	return expectScreenFlow(page, 'inbound');
};

const expectCapture = async (page: Page, state: MediaStreamTrackState, trackId?: string): Promise<void> => {
	const snapshot = await page.evaluate(() => ({
		calls: window.__ripcordE2eDisplayCaptureCalls,
		tracks: window.__ripcordE2eDisplayTracks?.map((track) => ({ id: track.id, state: track.readyState })),
	}));
	expect(snapshot.calls).toBe(1);
	expect(snapshot.tracks).toEqual([{ id: trackId ?? expect.any(String), state }]);
};

const expectScreenStopped = async (producer: Page, watcher: Page): Promise<void> => {
	await expectCapture(producer, 'ended');
	await expect.poll(async () => (await screenMediaStats(producer)).outbound.length).toBe(0);
	await expect(screenIndicator(watcher)).toHaveCount(0);
	await expect
		.poll(() =>
			watcher.evaluate(() => window.__ripcordE2eScreenReceiverTracks?.every((track) => track.readyState === 'ended')),
		)
		.toBe(true);
	await expect.poll(async () => (await screenMediaStats(watcher)).inbound.length).toBe(0);
};

// Hold the real signaling request before replacement transport creation. This
// leaves the live screen capture available for a UI stop during a rebuild.
const holdProducerTransportCreation = async (page: Page): Promise<void> => {
	await page.evaluate(() => {
		const nativeSend = WebSocket.prototype.send;
		let armed = true;
		const pending: { socket: WebSocket; data: string }[] = [];
		window.__ripcordE2eTransportGate = {
			held: 0,
			release: () => {
				armed = false;
				for (const { socket, data } of pending) nativeSend.call(socket, data);
				pending.length = 0;
			},
		};
		WebSocket.prototype.send = function (data) {
			if (armed && typeof data === 'string' && data.includes('voice.createProducerTransport')) {
				pending.push({ socket: this, data });
				if (window.__ripcordE2eTransportGate) window.__ripcordE2eTransportGate.held += 1;
				return;
			}
			nativeSend.call(this, data);
		};
	});
};

const sessionPhase = async (page: Page): Promise<string> =>
	page.evaluate(async () => {
		const modulePath = '/src/features/server/voice/voice-session-store.ts';
		const module: unknown = await import(modulePath);
		if (typeof module !== 'object' || module === null) throw new Error('No voice session store');
		const getState = Reflect.get(module, 'getVoiceSessionState');
		if (typeof getState !== 'function') throw new Error('No voice session state getter');
		const state: unknown = Reflect.apply(getState, module, []);
		const phase = typeof state === 'object' && state !== null ? Reflect.get(state, 'phase') : undefined;
		const name = typeof phase === 'object' && phase !== null ? Reflect.get(phase, 'phase') : undefined;
		if (typeof name !== 'string') throw new Error('Invalid voice session phase');
		return name;
	});

export {
	expectCapture,
	expectScreenFlow,
	expectScreenStopped,
	holdProducerTransportCreation,
	installScreenCapture,
	sessionPhase,
	startScreenShare,
	watchScreenShare,
};
