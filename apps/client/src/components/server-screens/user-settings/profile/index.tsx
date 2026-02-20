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
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { updateUser as updateUserAction } from '@/features/server/users/actions';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { useForm } from '@/hooks/use-form';
import { getTRPCClient } from '@/lib/trpc';
import { memo, useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { AvatarManager } from './avatar-manager';
import { BannerManager } from './banner-manager';

const HEX_COLOR_REGEX = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
const DEFAULT_BANNER_COLOR = '#FFFFFF';

const Profile = memo(() => {
  const ownPublicUser = useOwnPublicUser();
  const { setTrpcErrors, r, values, setValues, setError } = useForm({
    name: ownPublicUser?.name ?? '',
    bannerColor: ownPublicUser?.bannerColor ?? '#FFFFFF',
    bio: ownPublicUser?.bio ?? ''
  });
  const hydratedUserId = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!ownPublicUser || hydratedUserId.current === ownPublicUser.id) {
      return;
    }

    setValues({
      name: ownPublicUser.name,
      bannerColor: ownPublicUser.bannerColor ?? '#FFFFFF',
      bio: ownPublicUser.bio ?? ''
    });
    hydratedUserId.current = ownPublicUser.id;
  }, [ownPublicUser, setValues]);

  const onUpdateUser = useCallback(async () => {
    if (!ownPublicUser) {
      return;
    }

    const name = values.name.trim();
    const bio = values.bio.trim();
    const bannerColor = HEX_COLOR_REGEX.test(values.bannerColor.trim())
      ? values.bannerColor.trim()
      : DEFAULT_BANNER_COLOR;

    if (name.length === 0) {
      setError('name', 'Username is required');
      toast.error('Username is required');
      return;
    }

    const payload = {
      name,
      bannerColor,
      bio: bio.length > 0 ? bio : undefined
    };

    const trpc = getTRPCClient();

    try {
      await trpc.users.update.mutate(payload);
      updateUserAction(ownPublicUser.id, {
        name: payload.name,
        bannerColor: payload.bannerColor,
        bio: payload.bio ?? null
      });
      setValues({
        name: payload.name,
        bannerColor: payload.bannerColor,
        bio: payload.bio ?? ''
      });
      toast.success('Profile updated');
    } catch (error) {
      setTrpcErrors(error);
      toast.error('Could not update profile');
    }
  }, [
    ownPublicUser,
    setError,
    setTrpcErrors,
    setValues,
    values.bio,
    values.bannerColor,
    values.name
  ]);

  if (!ownPublicUser) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your Profile</CardTitle>
        <CardDescription>
          Update your personal information and settings here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-4">
          <div className="max-w-2xl space-y-4">
            <div className="space-y-2">
              <Label>Username</Label>
              <Input placeholder="Username" {...r('name')} />
            </div>

            <div className="space-y-2">
              <Label>Bio</Label>
              <Textarea
                placeholder="Tell us about yourself..."
                className="min-h-24"
                {...r('bio')}
              />
            </div>
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">Profile Media</h3>
            <p className="text-sm text-muted-foreground">
              Manage your avatar and banner image.
            </p>
          </div>

          <div className="grid gap-6 xl:grid-cols-[180px_minmax(0,1fr)] xl:items-start">
            <AvatarManager user={ownPublicUser} />
            <BannerManager user={ownPublicUser} />
          </div>
        </section>

      </CardContent>
      <CardFooter className="border-t items-stretch justify-end gap-2 sm:items-center">
        <Button onClick={onUpdateUser}>Save Changes</Button>
      </CardFooter>
    </Card>
  );
});

export { Profile };
