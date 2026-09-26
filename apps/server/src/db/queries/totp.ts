import { eq } from 'drizzle-orm';
import { db } from '..';
import { users } from '../schema';

type TTotpData = {
	totpSecret: string | null;
	totpRecoveryCodes: string | null;
};

const getUserTotpData = async (userId: number): Promise<TTotpData | undefined> => {
	return db
		.select({
			totpSecret: users.totpSecret,
			totpRecoveryCodes: users.totpRecoveryCodes,
		})
		.from(users)
		.where(eq(users.id, userId))
		.get();
};

const isUserTotpEnabled = async (userId: number): Promise<boolean> => {
	const result = await db.select({ totpSecret: users.totpSecret }).from(users).where(eq(users.id, userId)).get();

	return !!result?.totpSecret;
};

const updateUserRecoveryCodes = async (userId: number, hashedCodes: string[]): Promise<void> => {
	await db
		.update(users)
		.set({
			totpRecoveryCodes: JSON.stringify(hashedCodes),
			updatedAt: Date.now(),
		})
		.where(eq(users.id, userId))
		.run();
};

export { getUserTotpData, isUserTotpEnabled, updateUserRecoveryCodes };
