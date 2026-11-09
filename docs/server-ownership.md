# Server ownership and account recovery

## Claim ownership on a new server

On the first start, the server prints a secret access token once. Save it somewhere private: anyone holding it can become an Owner. The token itself cannot be recovered from the database, which stores only its hash.

1. Open the server in the web client and sign in with your own account (a new identity creates an account when registration is open).
2. Open your browser's developer console.
3. Run `useToken('<token>')`, replacing `<token>` with the secret token from the first-start output. On an account that is already an Owner this reports `Invalid access token`; that is expected.
4. The client confirms that your account is now an Owner.

The token grants ownership to the account you are signed into; it does not sign you into user 1 or reset that account's password. Store it securely for future recovery. An existing Owner can also grant the Owner role to another account.

Production installs create the built-in Ripcord account (user 1) with a random identity and a random password that is never printed. It cannot be signed into using a known default password. Claim ownership with your own account instead. Development and E2E retain identity `ripcord`, password `ripcord` and secret token `dev`. Never expose a server run from source (`bun run dev` / `start:web`) to the internet.

## Recover ownership or user 1

If you still have the secret token, sign in with your own account and run `useToken('<token>')` again to claim ownership. If you lost the token, ask another Owner to grant your account the Owner role. The original token cannot be retrieved.

To recover access to user 1, first become an Owner using the token, or ask an existing Owner for help. From a different Owner account, open user 1's moderation sheet. Owners can see its **Identity** under Details and use **Reset password** to set a new password. Sign in with that identity and password, then change the password when prompted. An Owner cannot reset their own password through this moderation action; another Owner must do it.

## Default-password rotation on upgrade

Production servers check user 1 at every startup. If its stored password still verifies as `ripcord` (including legacy hashes), the server replaces it with a random password, invalidates its access tokens, and revokes its refresh tokens. A password you already changed is left alone. Development and E2E do not rotate passwords.

The warning `Seed owner account (user 1) default password was rotated; existing sessions were revoked.` confirms that this protection ran. It contains no credentials and does not by itself mean the account was compromised.

If user 1 has any sign-in history (a recorded login, an issued session, or a join after the account was created), the server also prints its identity and new password once to standard output, and requires a password change on the next sign-in. This lets operators who used the account recover access. That output stays in `docker logs` and in any log shipper that collects the container's output, so keep it private and clear or rotate those logs if needed. Sign in and change the password, and review the account's sign-ins and Owner role assignments for unexpected activity. A sign-in you do not recognise may indicate that the old default password was abused.

Without sign-in history, the new password is discarded and no credentials are printed. New installs print nothing about user 1. Subsequent starts do not print a replacement credential because the password no longer matches the default. Use the recovery procedure above if you missed the one-time output.

Before upgrading, make sure you have the secret token or a personal Owner account. A changed password causes rotation to be skipped, so the startup check is not a complete compromise audit.
