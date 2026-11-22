import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveReleaseNotes } from '../update-release-notes';

const notesInfo = (versions: unknown) => ({
	version: '2.7.0',
	ripcordReleaseNotes: JSON.stringify({ versions }),
});

const NOTES = [
	{ version: '2.7.0', date: '2026-11-22', features: ['Install updates in the background'], fixes: [] },
	{ version: '2.6.6', date: '2026-11-20', features: [], fixes: ['Apply speaker volume to sound effects'] },
	{ version: '2.6.5', date: '2026-11-14', features: [], fixes: ['Restore screen share encoding'] },
	{ version: '2.6.4', date: '2026-11-13', features: [], fixes: ['Keep a stream live while its streamer reconnects'] },
];

void describe('resolveReleaseNotes', () => {
	void it('keeps only the versions between the running app and the update, newest first', () => {
		const notes = resolveReleaseNotes({
			info: notesInfo([...NOTES].reverse()),
			currentVersion: '2.6.5',
			availableVersion: '2.7.0',
		});

		assert.deepEqual(
			notes?.map((note) => note.version),
			['2.7.0', '2.6.6'],
		);
	});

	void it('ignores notes for versions newer than the update being installed', () => {
		const notes = resolveReleaseNotes({
			info: notesInfo(NOTES),
			currentVersion: '2.6.4',
			availableVersion: '2.6.6',
		});

		assert.deepEqual(
			notes?.map((note) => note.version),
			['2.6.6', '2.6.5'],
		);
	});

	void it('drops malformed entries, blank items, and invalid dates', () => {
		const notes = resolveReleaseNotes({
			info: notesInfo([
				{ version: '2.7.0', date: 'yesterday', features: ['  New thing  ', '', 42], fixes: 'not a list' },
				{ version: 'next', features: ['Hidden'], fixes: [] },
				{ version: '2.6.9', features: [], fixes: [] },
				'not an entry',
			]),
			currentVersion: '2.6.6',
			availableVersion: '2.7.0',
		});

		assert.deepEqual(notes, [{ version: '2.7.0', date: undefined, features: ['New thing'], fixes: [] }]);
	});

	void it('returns nothing for releases without notes or with unreadable notes', () => {
		for (const info of [{ version: '2.7.0' }, { version: '2.7.0', ripcordReleaseNotes: '{not json' }, notesInfo([])]) {
			assert.equal(resolveReleaseNotes({ info, currentVersion: '2.6.6', availableVersion: '2.7.0' }), undefined);
		}
	});

	void it('returns nothing when either version is not a stable release', () => {
		assert.equal(
			resolveReleaseNotes({ info: notesInfo(NOTES), currentVersion: '0.0.0-beta.4', availableVersion: '2.7.0' }),
			undefined,
		);
	});
});
