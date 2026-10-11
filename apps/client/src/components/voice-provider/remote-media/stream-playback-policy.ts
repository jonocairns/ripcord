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
	let lastReceived: number | undefined;
	let lastDecoded: number | undefined;
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
			lastReceived = undefined;
			lastDecoded = undefined;
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
		if (received) lastReceived = sample.now;
		if (decoded) lastDecoded = sample.now;
		// A changing screen may advance on only some polls. Keep evidence across
		// those gaps, but stop accumulating it once that stage's source is idle.
		decodeBlockedSince =
			decoded || sample.framesDecoded === undefined || lastReceived === undefined || sample.now - lastReceived >= 30_000
				? undefined
				: received
					? (decodeBlockedSince ?? sample.now)
					: decodeBlockedSince;
		renderBlockedSince =
			rendered || sample.framesRendered === undefined || lastDecoded === undefined || sample.now - lastDecoded >= 30_000
				? undefined
				: decoded
					? (renderBlockedSince ?? sample.now)
					: renderBlockedSince;
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
		// Inactivity cannot resolve or downgrade a blocked decode/render stage.
		// Keep that diagnosis until the stage itself advances.
		if (reason && reason !== diagnosed && diagnosed !== 'no_decoding' && diagnosed !== 'no_playback') {
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
