import type { TJoinedRole } from '@sharkord/shared';
import { useServerStore } from '../slice';

export const setRoles = (roles: TJoinedRole[]) =>
  useServerStore.getState().setRoles(roles);

export const addRole = (role: TJoinedRole) =>
  useServerStore.getState().addRole(role);

export const updateRole = (roleId: number, role: Partial<TJoinedRole>) =>
  useServerStore.getState().updateRole({ roleId, role });

export const removeRole = (roleId: number) =>
  useServerStore.getState().removeRole({ roleId });
