import type { IServerState } from './slice';

export const hasServerSessionSelector = (state: IServerState) => state.hasServerSession;

export const disconnectInfoSelector = (state: IServerState) => state.disconnectInfo;

export const mustChangePasswordSelector = (state: IServerState) => state.mustChangePassword;

export const serverNameSelector = (state: IServerState) => state.publicSettings?.name;

export const publicServerSettingsSelector = (state: IServerState) => state.publicSettings;

export const pluginsEnabledSelector = (state: IServerState) => !!state.publicSettings?.enablePlugins;

export const infoSelector = (state: IServerState) => state.info;

export const serverRejoinNonceSelector = (state: IServerState) => state.serverRejoinNonce;

export const fileAccessChangeNonceSelector = (state: IServerState) => state.fileAccessChangeNonce;
