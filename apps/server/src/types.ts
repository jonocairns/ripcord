export type TTokenPayload = {
  userId: number;
  tokenVersion: number;
  exp: number;
};

export type TConnectionInfo = {
  ip?: string;
  os?: string;
  device?: string;
  userAgent?: string;
};
