import { useServerStore } from '../slice';
import { roleByIdSelector, rolesSelector } from './selectors';

export const useRoleById = (roleId: number) =>
  useServerStore((state) => roleByIdSelector(state, roleId));

export const useRoles = () => useServerStore(rolesSelector);
