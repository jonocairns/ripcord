import { Button } from '@/components/ui/button';
import { UserAvatar } from '@/components/user-avatar';
import { setModViewOpen } from '@/features/app/actions';
import {
  openDialog,
  requestConfirmation,
  requestTextInput
} from '@/features/dialogs/actions';
import { useIsOwnUserOwner, useUserRoles } from '@/features/server/hooks';
import { useOwnUserId, useUserStatus } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { UserStatus } from '@sharkord/shared';
import { Gavel, KeyRound, LogOut, Plus, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { Dialog } from '../dialogs/dialogs';
import { RoleBadge } from '../role-badge';
import { useModViewContext } from './context';

const Header = memo(() => {
  const ownUserId = useOwnUserId();
  const isOwner = useIsOwnUserOwner();
  const { user, refetch } = useModViewContext();
  const canOwnerModerate = isOwner && user.id !== ownUserId;
  const status = useUserStatus(user.id);
  const userRoles = useUserRoles(user.id);

  const onRemoveRole = useCallback(
    async (roleId: number, roleName: string) => {
      const answer = await requestConfirmation({
        title: 'Remove Role',
        message: `Are you sure you want to remove the role "${roleName}" from this user?`,
        confirmLabel: 'Remove'
      });

      if (!answer) {
        return;
      }

      const trpc = getTRPCClient();

      try {
        await trpc.users.removeRole.mutate({
          userId: user.id,
          roleId
        });
        toast.success('Role removed successfully');
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to remove role'));
      } finally {
        refetch();
      }
    },
    [user.id, refetch]
  );

  const onKick = useCallback(async () => {
    const reason = await requestTextInput({
      title: 'Kick User',
      message: 'Please provide a reason for kicking this user (optional).',
      confirmLabel: 'Kick',
      allowEmpty: true
    });

    if (reason === null) {
      return;
    }

    const trpc = getTRPCClient();

    try {
      await trpc.users.kick.mutate({
        userId: user.id,
        reason
      });

      toast.success('User kicked successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to kick user'));
    } finally {
      refetch();
    }
  }, [user.id, refetch]);

  const onBan = useCallback(async () => {
    const trpc = getTRPCClient();

    const reason = await requestTextInput({
      title: 'Ban User',
      message: 'Please provide a reason for banning this user (optional).',
      confirmLabel: 'Ban',
      allowEmpty: true
    });

    if (reason === null) {
      return;
    }

    try {
      await trpc.users.ban.mutate({
        userId: user.id,
        reason
      });
      toast.success('User banned successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to ban user'));
    } finally {
      refetch();
    }
  }, [user.id, refetch]);

  const onUnban = useCallback(async () => {
    const trpc = getTRPCClient();

    const answer = await requestConfirmation({
      title: 'Unban User',
      message: 'Are you sure you want to unban this user?',
      confirmLabel: 'Unban'
    });

    if (!answer) {
      return;
    }

    try {
      await trpc.users.unban.mutate({
        userId: user.id
      });
      toast.success('User unbanned successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to unban user'));
    } finally {
      refetch();
    }
  }, [user.id, refetch]);

  const onResetPassword = useCallback(async () => {
    const newPassword = await requestTextInput({
      title: 'Reset Password',
      message: 'Set a new password for this user.',
      confirmLabel: 'Reset Password',
      type: 'password'
    });

    if (!newPassword) {
      return;
    }

    const trpc = getTRPCClient();

    try {
      await trpc.users.resetPassword.mutate({
        userId: user.id,
        newPassword
      });
      toast.success('Password reset successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to reset password'));
    }
  }, [user.id]);

  const onDeleteUser = useCallback(async () => {
    const answer = await requestConfirmation({
      title: 'Delete User',
      message:
        'Are you sure you want to permanently delete this user? This action cannot be undone.',
      confirmLabel: 'Delete User',
      variant: 'danger'
    });

    if (!answer) {
      return;
    }

    const trpc = getTRPCClient();

    try {
      await trpc.users.delete.mutate({
        userId: user.id
      });
      toast.success('User deleted successfully');
      setModViewOpen(false);
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to delete user'));
    }
  }, [user.id]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <UserAvatar userId={user.id} className="h-12 w-12" />
        <h2 className="text-lg font-bold text-foreground">{user.name}</h2>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Moderation
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={onKick}
            disabled={status === UserStatus.OFFLINE}
          >
            <LogOut className="h-4 w-4" />
            Kick User
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => (user.banned ? onUnban() : onBan())}
            disabled={user.id === ownUserId}
          >
            <Gavel className="h-4 w-4" />
            {user.banned ? 'Unban User' : 'Ban User'}
          </Button>
          {canOwnerModerate && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={onResetPassword}
              >
                <KeyRound className="h-4 w-4" />
                Reset Password
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="w-full justify-start"
                onClick={onDeleteUser}
              >
                <Trash2 className="h-4 w-4" />
                Delete User
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Roles
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {userRoles.map((role) => (
            <RoleBadge key={role.id} role={role} onRemoveRole={onRemoveRole} />
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => openDialog(Dialog.ASSIGN_ROLE, { user, refetch })}
          >
            <Plus className="h-3 w-3" />
            Assign Role
          </Button>
        </div>
      </div>
    </div>
  );
});

export { Header };
