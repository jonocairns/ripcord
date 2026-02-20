import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tooltip } from '@/components/ui/tooltip';
import { requestConfirmation } from '@/features/dialogs/actions';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { useForm } from '@/hooks/use-form';
import { getTRPCClient } from '@/lib/trpc';
import { OWNER_ROLE_ID, type TJoinedRole } from '@sharkord/shared';
import { Info, Star, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { PermissionList } from './permissions-list';

type TUpdateRoleProps = {
  selectedRole: TJoinedRole;
  setSelectedRoleId: (id: number | undefined) => void;
  refetch: () => void;
};

const UpdateRole = memo(
  ({ selectedRole, setSelectedRoleId, refetch }: TUpdateRoleProps) => {
    const { setTrpcErrors, r, onChange, values } = useForm({
      name: selectedRole.name,
      color: selectedRole.color,
      permissions: selectedRole.permissions
    });

    const isOwnerRole = selectedRole.id === OWNER_ROLE_ID;

    const onDeleteRole = useCallback(async () => {
      const choice = await requestConfirmation({
        title: 'Delete Role',
        message: `Are you sure you want to delete this role? If there are members with this role, they will be moved to the default role. This action cannot be undone.`,
        confirmLabel: 'Delete'
      });

      if (!choice) return;

      const trpc = getTRPCClient();

      try {
        await trpc.roles.delete.mutate({ roleId: selectedRole.id });
        toast.success('Role deleted');
        refetch();
        setSelectedRoleId(undefined);
      } catch {
        toast.error('Failed to delete role');
      }
    }, [selectedRole.id, refetch, setSelectedRoleId]);

    const onUpdateRole = useCallback(async () => {
      const trpc = getTRPCClient();

      try {
        await trpc.roles.update.mutate({
          roleId: selectedRole.id,
          ...values
        });

        toast.success('Role updated');
        refetch();
      } catch (error) {
        setTrpcErrors(error);
      }
    }, [selectedRole.id, values, refetch, setTrpcErrors]);

    const onSetAsDefaultRole = useCallback(async () => {
      const choice = await requestConfirmation({
        title: 'Set as Default Role',
        message: `Are you sure you want to set this role as the default role? New members will be assigned this role upon joining.`,
        confirmLabel: 'Set as Default'
      });

      if (!choice) return;

      const trpc = getTRPCClient();

      try {
        await trpc.roles.setDefault.mutate({ roleId: selectedRole.id });

        toast.success('Default role updated');
        refetch();
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to set default role'));
      }
    }, [selectedRole.id, refetch]);

    return (
      <Card className="flex-1 gap-0 py-0">
        <CardHeader className="border-b py-6">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-lg">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: selectedRole.color }}
                />
                {selectedRole.name}
              </CardTitle>
              <CardDescription>
                Edit role details and permissions.
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Tooltip content="Set as Default Role">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={selectedRole.isDefault}
                  onClick={onSetAsDefaultRole}
                  title="Set as default role"
                >
                  <Star className="h-4 w-4" />
                </Button>
              </Tooltip>
              <Button
                size="icon"
                variant="ghost"
                disabled={selectedRole.isPersistent || selectedRole.isDefault}
                onClick={onDeleteRole}
                title="Delete role"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 space-y-6 overflow-y-auto py-6">
          {selectedRole.isDefault && (
            <Alert variant="default">
              <Star />
              <AlertDescription>
                This is the default role. New members will be assigned this role
                upon joining.
              </AlertDescription>
            </Alert>
          )}

          {isOwnerRole && (
            <Alert variant="default">
              <Info />
              <AlertDescription>
                This is the owner role. This role has all permissions and cannot
                be deleted or have its permissions changed.
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
            <div className="space-y-2">
              <Label htmlFor="role-name">Role Name</Label>
              <Input id="role-name" {...r('name')} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="role-color">Role Color</Label>
              <div className="flex gap-2">
                <Input
                  id="role-color"
                  className="h-10 w-14 flex-none p-1"
                  {...r('color', 'color')}
                />
                <Input className="font-mono" {...r('color')} />
              </div>
            </div>
          </div>

          <PermissionList
            permissions={values.permissions}
            disabled={OWNER_ROLE_ID === selectedRole.id}
            setPermissions={(permissions) =>
              onChange('permissions', permissions)
            }
          />
        </CardContent>
        <CardFooter className="border-t justify-end gap-2 py-4">
          <Button
            variant="outline"
            onClick={() => setSelectedRoleId(undefined)}
          >
            Close
          </Button>
          <Button onClick={onUpdateRole}>Save Role</Button>
        </CardFooter>
      </Card>
    );
  }
);

export { UpdateRole };
