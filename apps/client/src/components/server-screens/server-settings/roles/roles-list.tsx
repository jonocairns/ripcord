import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import type { TJoinedRole } from '@sharkord/shared';
import { Plus } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

type TRolesListProps = {
  roles: TJoinedRole[];
  selectedRoleId: number | undefined;
  setSelectedRoleId: (roleId: number) => void;
  refetch: () => void;
};

const RolesList = memo(
  ({ roles, selectedRoleId, setSelectedRoleId, refetch }: TRolesListProps) => {
    const [search, setSearch] = useState('');

    const filteredRoles = useMemo(() => {
      const normalizedSearch = search.trim().toLowerCase();

      if (!normalizedSearch) {
        return roles;
      }

      return roles.filter((role) =>
        role.name.toLowerCase().includes(normalizedSearch)
      );
    }, [roles, search]);

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
        <CardHeader className="gap-2 px-4">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Roles</CardTitle>
            <Button
              size="icon"
              variant="ghost"
              onClick={onAddRole}
              title="Create role"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <CardDescription>
            {roles.length} {roles.length === 1 ? 'role' : 'roles'}
          </CardDescription>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search roles"
          />
        </CardHeader>
        <CardContent className="px-2">
          <div className="max-h-[320px] space-y-1 overflow-y-auto pr-1">
            {filteredRoles.map((role) => (
              <button
                key={role.id}
                onClick={() => setSelectedRoleId(role.id)}
                className={cn(
                  'hover:bg-accent flex w-full items-center justify-between rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors',
                  selectedRoleId === role.id && 'bg-accent border-border'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: role.color }}
                  />
                  <span className="truncate">{role.name}</span>
                </div>
                {role.isDefault && (
                  <span className="text-xs text-muted-foreground">Default</span>
                )}
              </button>
            ))}

            {filteredRoles.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">
                No roles found.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
);

export { RolesList };
