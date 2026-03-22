import type { IServerState } from './server-store';

export const rolesSelector = (state: IServerState) => state.roles;

export const roleByIdSelector = (state: IServerState, roleId: number) => state.roles.find((role) => role.id === roleId);
