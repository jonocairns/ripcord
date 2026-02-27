import { Password } from '@/components/server-screens/user-settings/password';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ShieldAlert } from 'lucide-react';
import { memo } from 'react';

const ForcePasswordReset = memo(() => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldAlert className="h-5 w-5 text-yellow-500" />
              Password Reset Required
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            A server owner reset your password. You must set a new password
            before continuing.
          </CardContent>
        </Card>
        <Password forceMode />
      </div>
    </div>
  );
});

export { ForcePasswordReset };
