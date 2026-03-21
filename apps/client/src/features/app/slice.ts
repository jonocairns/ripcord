import { create } from 'zustand';
import type { TDevices } from '@/types';

export interface TAppState {
	loading: boolean;
	devices: TDevices | undefined;
	modViewOpen: boolean;
	modViewUserId?: number;
}

const initialState: TAppState = {
	loading: true,
	devices: undefined,
	modViewOpen: false,
	modViewUserId: undefined,
};

export const useAppStore = create<TAppState>(() => initialState);
