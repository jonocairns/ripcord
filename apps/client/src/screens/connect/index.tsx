import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Group } from '@/components/ui/group';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { connect } from '@/features/server/actions';
import { useInfo } from '@/features/server/hooks';
import { getFileUrl, getUrlFromServer } from '@/helpers/get-file-url';
import { useForm } from '@/hooks/use-form';
import { LocalStorageKey, SessionStorageKey } from '@/types';
import { memo, useCallback, useMemo, useState } from 'react';

const Connect = memo(() => {
  const { values, r, setErrors, onChange } = useForm<{
    identity: string;
    password: string;
    rememberCredentials: boolean;
  }>({
    identity: localStorage.getItem(LocalStorageKey.IDENTITY) || '',
    password: localStorage.getItem(LocalStorageKey.USER_PASSWORD) || '',
    rememberCredentials: !!localStorage.getItem(
      LocalStorageKey.REMEMBER_CREDENTIALS
    )
  });

  const [loading, setLoading] = useState(false);
  const info = useInfo();

  const inviteCode = useMemo(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const invite = urlParams.get('invite');
    return invite || undefined;
  }, []);

  const onRememberCredentialsChange = useCallback(
    (checked: boolean) => {
      onChange('rememberCredentials', checked);

      if (checked) {
        localStorage.setItem(LocalStorageKey.REMEMBER_CREDENTIALS, 'true');
      } else {
        localStorage.removeItem(LocalStorageKey.REMEMBER_CREDENTIALS);
      }
    },
    [onChange]
  );

  const onConnectClick = useCallback(async () => {
    setLoading(true);
    try {
      const url = getUrlFromServer();
      const response = await fetch(`${url}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          identity: values.identity,
          password: values.password,
          invite: inviteCode
        })
      });

      if (!response.ok) {
        const data = await response.json();
        setErrors(data.errors || {});
        return;
      }

      const data = (await response.json()) as { token: string };

      sessionStorage.setItem(SessionStorageKey.TOKEN, data.token);

      if (values.rememberCredentials) {
        localStorage.setItem(LocalStorageKey.IDENTITY, values.identity);
        localStorage.setItem(LocalStorageKey.USER_PASSWORD, values.password);
      }

      await connect();
    } finally {
      setLoading(false);
    }
  }, [
    values.identity,
    values.password,
    setErrors,
    values.rememberCredentials,
    inviteCode
  ]);

  const logoSrc = useMemo(() => {
    if (info?.logo) {
      return getFileUrl(info.logo);
    }

    return '/logo.webp';
  }, [info]);

  return (
    <div className="flex flex-col gap-2 justify-center items-center h-full">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex justify-center">
            <img src={logoSrc} alt="Sharkord" className="w-32 h-32" />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {info?.description && (
            <span className="text-sm text-muted-foreground">
              {info?.description}
            </span>
          )}

          <div className="flex flex-col gap-2">
            <Group
              label="Identity"
              help="A unique identifier for your account on this server. You can use whatever you like, such as an email address or a username. This won't be shared publicly."
            >
              <Input {...r('identity')} />
            </Group>
            <Group label="Password">
              <Input
                {...r('password')}
                type="password"
                onEnter={onConnectClick}
              />
            </Group>
            <Group label="Remember Credentials">
              <Switch
                checked={values.rememberCredentials}
                onCheckedChange={onRememberCredentialsChange}
              />
            </Group>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              className="w-full"
              variant="outline"
              onClick={onConnectClick}
              disabled={loading || !values.identity || !values.password}
            >
              Connect
            </Button>
            {!info?.allowNewUsers && (
              <>
                {!inviteCode && (
                  <span className="text-xs text-muted-foreground text-center">
                    New user registrations are currently disabled. If you do not
                    have an account yet, you need to be invited by an existing
                    user to join this server.
                  </span>
                )}
              </>
            )}

            {inviteCode && (
              <Alert variant="info">
                <AlertTitle>You were invited to join this server</AlertTitle>
                <AlertDescription>
                  <span className="font-mono text-xs">
                    Invite code: {inviteCode}
                  </span>
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
});

export { Connect };
