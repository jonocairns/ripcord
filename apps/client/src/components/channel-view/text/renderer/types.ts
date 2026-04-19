import type { TFile } from '@sharkord/shared';

export type TFoundMedia = {
	type: 'image' | 'video' | 'audio';
	url: string;
	file?: TFile;
};
