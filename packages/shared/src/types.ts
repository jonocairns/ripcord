import { type TFile, type TSettings, type TUser } from ".";

export enum StorageOverflowAction {
  DELETE_OLD_FILES = "delete", // when new uploads exceed the quota, delete the oldest files
  PREVENT_UPLOADS = "prevent", // when new uploads exceed the quota, prevent new uploads
}

export const STORAGE_OVERFLOW_ACTIONS_DICT = {
  [StorageOverflowAction.DELETE_OLD_FILES]: "Delete old files",
  [StorageOverflowAction.PREVENT_UPLOADS]: "Prevent new file uploads",
};

export const STORAGE_OVERFLOW_ACTIONS_DESCRIPTION = {
  [StorageOverflowAction.DELETE_OLD_FILES]:
    "When new uploads exceed the quota, the server will automatically delete the oldest files to make room for new uploads.",
  [StorageOverflowAction.PREVENT_UPLOADS]:
    "When new uploads exceed the quota, the server will prevent new uploads until the user deletes some files manually.",
};

export enum ChannelType {
  TEXT = "TEXT",
  VOICE = "VOICE",
}

export type TServerSettings = {
  serverId: string;
  name: string;
  description: string;
};

export type TGenericObject = {
  [key: string]: any;
};

export type TGenericFunction = {
  (...args: any[]): any;
};

export type TMessageMetadata = {
  url: string;
  title?: string;
  siteName?: string;
  description?: string;
  mediaType: string;
  images?: string[];
  videos?: string[];
  favicons?: string[];
};

export type WithOptional<T, K extends keyof T> = Omit<T, K> &
  Partial<Pick<T, K>>;

export enum UserStatus {
  ONLINE = "online",
  IDLE = "idle",
  OFFLINE = "offline",
}

export type TOwnUser = WithOptional<TUser, "identity">;

export type TConnectionParams = {
  token: string;
};

export type TTempFile = {
  id: string;
  originalName: string;
  size: number;
  md5: string;
  path: string;
  extension: string;
  userId: number;
};

export type TServerInfo = Pick<
  TSettings,
  "serverId" | "name" | "description" | "allowNewUsers"
> & {
  logo: TFile | null;
  version: string;
};

export type TArtifact = {
  name: string;
  target: string;
  size: number;
  checksum: string;
};

export type TVersionInfo = {
  version: string;
  releaseDate: string;
  artifacts: TArtifact[];
};
