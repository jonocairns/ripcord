import type { TDevices } from '@/types';
import { create } from 'zustand';

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
  modViewUserId: undefined
};

export const useAppStore = create<TAppState>(() => initialState);
