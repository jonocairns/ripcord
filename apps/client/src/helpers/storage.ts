export enum LocalStorageKey {
  IDENTITY = 'sharkord-identity',
  REMEMBER_CREDENTIALS = 'sharkord-remember-identity',
  USER_PASSWORD = 'sharkord-user-password',
  SERVER_PASSWORD = 'sharkord-server-password',
  VITE_UI_THEME = 'vite-ui-theme'
}

export enum SessionStorageKey {
  TOKEN = 'sharkord-token'
}

const getLocalStorageItem = (key: LocalStorageKey): string | null => {
  return localStorage.getItem(key);
};

const setLocalStorageItem = (key: LocalStorageKey, value: string): void => {
  localStorage.setItem(key, value);
};

const removeLocalStorageItem = (key: LocalStorageKey): void => {
  localStorage.removeItem(key);
};

const getSessionStorageItem = (key: SessionStorageKey): string | null => {
  return sessionStorage.getItem(key);
};

const setSessionStorageItem = (key: SessionStorageKey, value: string): void => {
  sessionStorage.setItem(key, value);
};

const removeSessionStorageItem = (key: SessionStorageKey): void => {
  sessionStorage.removeItem(key);
};

export {
  getLocalStorageItem,
  getSessionStorageItem,
  removeLocalStorageItem,
  removeSessionStorageItem,
  setLocalStorageItem,
  setSessionStorageItem
};
