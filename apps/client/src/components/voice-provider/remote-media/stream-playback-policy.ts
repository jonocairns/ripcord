import type { TStreamEventDetails } from '@sharkord/shared';

export type TPlaybackSample = {
	now: number;
	eligible: boolean;
	transportConnected: boolean;
	bytesReceived?: number;
	framesReceived?: number;
	framesDecoded?: number;
	framesRendered?: number;
};

// Only moving source-frame counters support a decode/render failure. An idle
// static screen is ambiguous, so it produces inactivity diagnostics, not errors.
export const createStreamPlaybackPolicy = () => {
	let previous: TPlaybackSample | undefined;
	let firstFrame = false;
	let lastIncoming: number | undefined;
	let decodeBlockedSince: number | undefined;
	let renderBlockedSince: number | undefined;
	let diagnosed: TStreamEventDetails['reason'];
	return (sample: TPlaybackSample): TStreamEventDetails[] => {
		const events: TStreamEventDetails[] = [];
		const counters = {
			bytesReceived: sample.bytesReceived,
			framesReceived: sample.framesReceived,
			framesDecoded: sample.framesDecoded,
			framesRendered: sample.framesRendered,
		};
		if (!sample.eligible) {
			previous = undefined;
			lastIncoming = undefined;
			decodeBlockedSince = undefined;
			renderBlockedSince = undefined;
			diagnosed = undefined;
			return events;
		}
		const advancing = (value: number | undefined, before: number | undefined) =>
			value !== undefined && before !== undefined && value > before;
		const rendered =
			advancing(sample.framesRendered, previous?.framesRendered) || (!firstFrame && (sample.framesRendered ?? 0) > 0);
		const decoded = advancing(sample.framesDecoded, previous?.framesDecoded);
		const received = advancing(sample.framesReceived, previous?.framesReceived);
		if (rendered && !firstFrame) {
			firstFrame = true;
			events.push({ event: 'playback_first_frame', ...counters });
		}
		if (!previous || received || decoded || rendered) lastIncoming = sample.now;
		decodeBlockedSince =
			received && sample.framesDecoded !== undefined && !decoded ? (decodeBlockedSince ?? sample.now) : undefined;
		renderBlockedSince =
			decoded && sample.framesRendered !== undefined && !rendered ? (renderBlockedSince ?? sample.now) : undefined;
		let reason: TStreamEventDetails['reason'];
		if (decodeBlockedSince !== undefined && sample.now - decodeBlockedSince >= 15_000) reason = 'no_decoding';
		else if (renderBlockedSince !== undefined && sample.now - renderBlockedSince >= 15_000) reason = 'no_playback';
		else if (lastIncoming !== undefined && sample.now - lastIncoming >= 30_000)
			reason = sample.transportConnected ? 'static_or_idle' : 'no_incoming_media';
		const recovered =
			diagnosed === 'no_playback'
				? rendered
				: diagnosed === 'no_decoding'
					? decoded || rendered
					: received || decoded || rendered;
		if (diagnosed && recovered) {
			events.push({ event: 'playback_recovered', ...counters });
			diagnosed = undefined;
		}
		if (reason && reason !== diagnosed) {
			events.push({
				event: reason === 'no_decoding' || reason === 'no_playback' ? 'playback_stalled' : 'playback_inactive',
				reason,
				...counters,
			});
			diagnosed = reason;
		}
		previous = sample;
		return events;
	};
};
