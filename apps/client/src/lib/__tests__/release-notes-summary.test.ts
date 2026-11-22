import { describe, expect, it } from 'bun:test';
import { summarizeReleaseNotes } from '../release-notes-summary';

const NOTES = [
	{ version: '2.7.0', features: ['Install updates in the background'], fixes: ['Keep the window size'] },
	{ version: '2.6.6', features: [], fixes: ['Apply speaker volume to sound effects', 'Keep the window size'] },
	{ version: '2.6.5', features: ['Show release notes'], fixes: ['Restore screen share encoding'] },
];

describe('summarizeReleaseNotes', () => {
	it('lists features from every skipped version before fixes, without duplicates', () => {
		expect(summarizeReleaseNotes(NOTES)).toEqual({
			features: ['Install updates in the background', 'Show release notes'],
			fixes: ['Keep the window size', 'Apply speaker volume to sound effects', 'Restore screen share encoding'],
			hiddenCount: 0,
		});
	});

	it('counts the items that do not fit', () => {
		expect(summarizeReleaseNotes(NOTES, 3)).toEqual({
			features: ['Install updates in the background', 'Show release notes'],
			fixes: ['Keep the window size'],
			hiddenCount: 2,
		});
	});
});
