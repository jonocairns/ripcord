import { OWNER_ROLE_ID, type TJoinedRole } from '@sharkord/shared';
import { Plus } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';

type TRolesListProps = {
	roles: TJoinedRole[];
	selectedRoleId: number | undefined;
	setSelectedRoleId: (roleId: number) => void;
	refetch: () => void;
};

const RolesList = memo(({ roles, selectedRoleId, setSelectedRoleId, refetch }: TRolesListProps) => {
	const onAddRole = useCallback(async () => {
		const trpc = getTRPCClient();

		try {
			const newRoleId = await trpc.roles.add.mutate();

			await refetch();

			setSelectedRoleId(newRoleId);
			toast.success('Role created');
		} catch {
			toast.error('Could not create role');
		}
	}, [refetch, setSelectedRoleId]);

	return (
		<Card className="w-full gap-4 py-4">
			<CardHeader className="gap-3 px-4">
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-1">
						<CardTitle className="text-base">Roles</CardTitle>
						<CardDescription>Select a role to edit its details and permissions.</CardDescription>
					</div>
					<Button onClick={onAddRole}>
						<Plus className="h-4 w-4" />
						New role
					</Button>
				</div>
			</CardHeader>
			<CardContent className="px-4 pt-0">
				<div className="flex flex-wrap gap-2">
					{roles.map((role) => (
						<button
							key={role.id}
							onClick={() => setSelectedRoleId(role.id)}
							className={cn(
								'hover:bg-accent flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
								selectedRoleId === role.id ? 'bg-accent border-border' : 'border-border/60',
							)}
						>
							<div className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: role.color }} />
							<span className="truncate">{role.name}</span>
							{role.id === OWNER_ROLE_ID && <span className="text-xs text-muted-foreground">Owner</span>}
							{role.isDefault && <span className="text-xs text-muted-foreground">Default</span>}
						</button>
					))}

					{roles.length === 0 && (
						<p className="px-1 py-2 text-sm text-muted-foreground">No roles yet. Create one to get started.</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
});

export { RolesList };
