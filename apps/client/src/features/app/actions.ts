import { getUrlFromServer } from '@/helpers/get-file-url';
import {
  getAuthToken,
  getRefreshToken,
  hydrateSessionToken
} from '@/helpers/storage';
import type { TServerInfo } from '@sharkord/shared';
import { toast } from 'sonner';
import { connect, setInfo } from '../server/actions';
import { store } from '../store';
import { appSliceActions } from './slice';

export const setAppLoading = (loading: boolean) =>
  store.dispatch(appSliceActions.setAppLoading(loading));

export const fetchServerInfo = async (): Promise<TServerInfo | undefined> => {
  try {
    const url = getUrlFromServer();
    const response = await fetch(`${url}/info`);

    if (!response.ok) {
      throw new Error('Failed to fetch server info');
    }

    const data = await response.json();

    return data;
  } catch (error) {
    console.error('Error fetching server info:', error);
  }
};

export const loadApp = async () => {
  try {
    const info = await fetchServerInfo();

    if (!info) {
      console.error('Failed to load server info during app load');
      toast.error('Failed to load server info');
      return;
    }

    setInfo(info);

    const existingToken = getAuthToken();
    const existingRefreshToken = getRefreshToken();

    if (existingToken || existingRefreshToken) {
      hydrateSessionToken();

      try {
        await connect();
      } catch (error) {
        console.error('Failed to auto-connect with persisted auth token', error);
      }
    }
  } finally {
    setAppLoading(false);
  }
};

export const setModViewOpen = (isOpen: boolean, userId?: number) =>
  store.dispatch(
    appSliceActions.setModViewOpen({
      modViewOpen: isOpen,
      userId
    })
  );

export const resetApp = () => {
  store.dispatch(
    appSliceActions.setModViewOpen({
      modViewOpen: false,
      userId: undefined
    })
  );
};
