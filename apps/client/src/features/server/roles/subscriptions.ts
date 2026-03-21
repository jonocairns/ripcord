import type { TJoinedRole } from '@sharkord/shared';
import { getTRPCClient } from '@/lib/trpc';
import { addRole, removeRole, updateRole } from './actions';

const subscribeToRoles = () => {
	const trpc = getTRPCClient();

	const onRoleCreateSub = trpc.roles.onCreate.subscribe(undefined, {
		onData: (role: TJoinedRole) => addRole(role),
		onError: (err) => console.error('onRoleCreate subscription error:', err),
	});

	const onRoleDeleteSub = trpc.roles.onDelete.subscribe(undefined, {
		onData: (roleId: number) => removeRole(roleId),
		onError: (err) => console.error('onRoleDelete subscription error:', err),
	});

	const onRoleUpdateSub = trpc.roles.onUpdate.subscribe(undefined, {
		onData: (role: TJoinedRole) => updateRole(role.id, role),
		onError: (err) => console.error('onRoleUpdate subscription error:', err),
	});

	return () => {
		onRoleCreateSub.unsubscribe();
		onRoleDeleteSub.unsubscribe();
		onRoleUpdateSub.unsubscribe();
	};
};

export { subscribeToRoles };
