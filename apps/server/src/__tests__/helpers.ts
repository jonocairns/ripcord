import { UploadHeaders } from '@sharkord/shared';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { getServerToken } from '../db/queries/server';
import { appRouter } from '../routers';
import { createMockContext } from './context';
import { testsBaseUrl } from './setup';

const getMockedToken = async (userId: number) => {
  const token = jwt.sign({ userId: userId }, await getServerToken(), {
    expiresIn: '86400s',
    jwtid: randomUUID()
  });

  return token;
};

const getCaller = async (userId: number) => {
  const mockedToken = await getMockedToken(userId);

  const caller = appRouter.createCaller(
    await createMockContext({
      customToken: mockedToken
    })
  );

  return { caller, mockedToken };
};

// this will basically simulate a specific user connecting to the server
const initTest = async (userId: number = 1) => {
  const { caller, mockedToken } = await getCaller(userId);
  const { handshakeHash } = await caller.others.handshake();

  const initialData = await caller.others.joinServer({
    handshakeHash: handshakeHash
  });

  return { caller, mockedToken, initialData };
};

const login = async (identity: string, password: string, invite?: string) =>
  fetch(`${testsBaseUrl}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      identity,
      password,
      invite
    })
  });

const refresh = async (refreshToken: string) =>
  fetch(`${testsBaseUrl}/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ refreshToken })
  });

const logout = async (refreshToken: string) =>
  fetch(`${testsBaseUrl}/logout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ refreshToken })
  });

const uploadFile = async (file: File, token: string) =>
  fetch(`${testsBaseUrl}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      [UploadHeaders.TYPE]: file.type,
      [UploadHeaders.CONTENT_LENGTH]: file.size.toString(),
      [UploadHeaders.ORIGINAL_NAME]: file.name,
      [UploadHeaders.TOKEN]: token
    },
    body: file
  });

export {
  getCaller,
  getMockedToken,
  initTest,
  login,
  logout,
  refresh,
  uploadFile
};
