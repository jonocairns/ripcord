import { getUrlFromServer } from './get-file-url';
import { clearAuthToken, getRefreshToken, setAuthTokens } from './storage';

type TRefreshResponse = {
  token: string;
  refreshToken: string;
};

const refreshAccessToken = async (): Promise<boolean> => {
  const refreshToken = getRefreshToken();

  if (!refreshToken) {
    return false;
  }

  try {
    const response = await fetch(`${getUrlFromServer()}/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refreshToken })
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        clearAuthToken();
      }

      return false;
    }

    const data = (await response.json()) as TRefreshResponse;

    if (!data.token || !data.refreshToken) {
      clearAuthToken();
      return false;
    }

    setAuthTokens(data.token, data.refreshToken);
    return true;
  } catch {
    return false;
  }
};

const revokeRefreshToken = async (): Promise<void> => {
  const refreshToken = getRefreshToken();

  if (!refreshToken) {
    return;
  }

  try {
    await fetch(`${getUrlFromServer()}/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ refreshToken })
    });
  } catch {
    // best effort only - local token clear still logs user out
  }
};

export { refreshAccessToken, revokeRefreshToken };
