import { Card, CardContent } from '@/components/ui/card';
import { LoadingCard } from '@/components/ui/loading-card';
import { useAdminRoles } from '@/features/server/admin/hooks';
import { Shield } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { RolesList } from './roles-list';
import { UpdateRole } from './update-role';

const Roles = memo(() => {
  const { roles, refetch, loading } = useAdminRoles();

  const [selectedRoleId, setSelectedRoleId] = useState<number | undefined>();

  useEffect(() => {
    if (roles.length === 0) return;

    const roleExists = roles.some((role) => role.id === selectedRoleId);

    if (selectedRoleId && roleExists) return;

    const nextRoleId = roles.find((role) => role.isDefault)?.id ?? roles[0].id;

    setSelectedRoleId(nextRoleId);
  }, [roles, selectedRoleId]);

  const selectedRole = useMemo(() => {
    return roles.find((r) => r.id === selectedRoleId) || null;
  }, [roles, selectedRoleId]);

  if (loading) {
    return <LoadingCard className="h-[600px]" />;
  }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
      <RolesList
        roles={roles}
        selectedRoleId={selectedRoleId}
        setSelectedRoleId={setSelectedRoleId}
        refetch={refetch}
      />
      {selectedRole ? (
        <UpdateRole
          key={selectedRole.id}
          selectedRole={selectedRole}
          setSelectedRoleId={setSelectedRoleId}
          refetch={refetch}
        />
      ) : (
        <Card className="min-h-[560px] border-dashed">
          <CardContent className="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="bg-muted flex h-12 w-12 items-center justify-center rounded-full">
              <Shield className="text-muted-foreground h-6 w-6" />
            </div>
            <p className="text-foreground text-base font-medium">
              Select a role to edit
            </p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Choose a role from the list, or create a new one.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
});

export { Roles };
