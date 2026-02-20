import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { useForm } from '@/hooks/use-form';
import { getTRPCClient } from '@/lib/trpc';
import { Eye, EyeOff } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

const MIN_PASSWORD_LENGTH = 8;

const Password = memo(() => {
  const { setTrpcErrors, r, values } = useForm({
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: ''
  });
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const hasAllFields = useMemo(
    () =>
      values.currentPassword.length > 0 &&
      values.newPassword.length > 0 &&
      values.confirmNewPassword.length > 0,
    [values.confirmNewPassword, values.currentPassword, values.newPassword]
  );
  const isDirty = useMemo(
    () =>
      values.currentPassword.length > 0 ||
      values.newPassword.length > 0 ||
      values.confirmNewPassword.length > 0,
    [values.confirmNewPassword, values.currentPassword, values.newPassword]
  );
  const isPasswordLongEnough = values.newPassword.length >= MIN_PASSWORD_LENGTH;
  const passwordsMatch = values.newPassword === values.confirmNewPassword;
  const canSubmit = hasAllFields && isDirty && isPasswordLongEnough && passwordsMatch;

  const updatePassword = useCallback(async () => {
    if (!canSubmit) {
      return;
    }

    const trpc = getTRPCClient();

    try {
      await trpc.users.updatePassword.mutate(values);
      toast.success('Password updated!');
    } catch (error) {
      setTrpcErrors(error);
    }
  }, [canSubmit, values, setTrpcErrors]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          In this section, you can update your password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Group label="Current Password">
          <div className="relative">
            <Input
              {...r('currentPassword')}
              type={showCurrentPassword ? 'text' : 'password'}
              className="pr-10"
              onEnter={canSubmit ? updatePassword : undefined}
            />
            <button
              type="button"
              className="absolute top-[18px] right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowCurrentPassword((prev) => !prev)}
              aria-label={
                showCurrentPassword
                  ? 'Hide current password'
                  : 'Show current password'
              }
            >
              {showCurrentPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
        </Group>

        <Group label="New Password">
          <div className="space-y-1">
            <div className="relative">
              <Input
                {...r('newPassword')}
                type={showNewPassword ? 'text' : 'password'}
                className="pr-10"
                onEnter={canSubmit ? updatePassword : undefined}
              />
              <button
                type="button"
                className="absolute top-[18px] right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowNewPassword((prev) => !prev)}
                aria-label={
                  showNewPassword ? 'Hide new password' : 'Show new password'
                }
              >
                {showNewPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Must be at least {MIN_PASSWORD_LENGTH} characters.
            </p>
            {values.newPassword.length > 0 && !isPasswordLongEnough && (
              <p className="text-xs text-destructive">
                Password must be at least {MIN_PASSWORD_LENGTH} characters.
              </p>
            )}
          </div>
        </Group>

        <Group label="Confirm New Password">
          <div className="space-y-1">
            <div className="relative">
              <Input
                {...r('confirmNewPassword')}
                type={showConfirmPassword ? 'text' : 'password'}
                className="pr-10"
                onEnter={canSubmit ? updatePassword : undefined}
              />
              <button
                type="button"
                className="absolute top-[18px] right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setShowConfirmPassword((prev) => !prev)}
                aria-label={
                  showConfirmPassword
                    ? 'Hide confirm password'
                    : 'Show confirm password'
                }
              >
                {showConfirmPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {values.confirmNewPassword.length > 0 && !passwordsMatch && (
              <p className="text-xs text-destructive">Passwords do not match.</p>
            )}
          </div>
        </Group>
      </CardContent>
      <CardFooter className="border-t items-stretch justify-end gap-2 sm:items-center">
        <Button onClick={updatePassword} disabled={!canSubmit}>
          Update Password
        </Button>
      </CardFooter>
    </Card>
  );
});

export { Password };
