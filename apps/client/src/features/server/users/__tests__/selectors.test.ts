import { UserStatus, type TJoinedPublicUser } from '@sharkord/shared';
import { describe, expect, it } from 'bun:test';
import { sortUsers } from '../selectors';

const createUser = ({
	id,
	name,
	banned = false,
	status = UserStatus.OFFLINE,
}: {
	id: number;
	name: string;
	banned?: boolean;
	status?: UserStatus;
}) =>
	({
		id,
		name,
		banned,
		status,
	}) as unknown as TJoinedPublicUser;

describe('sortUsers', () => {
	it('sorts non-banned users alphabetically regardless of presence status and keeps banned users last', () => {
		const sorted = sortUsers([
			createUser({ id: 1, name: 'Zed', status: UserStatus.ONLINE }),
			createUser({ id: 2, name: 'alice', status: UserStatus.OFFLINE }),
			createUser({ id: 3, name: 'Mira', status: UserStatus.IDLE, banned: true }),
			createUser({ id: 4, name: 'Bob', status: UserStatus.IDLE }),
			createUser({ id: 5, name: 'Aaron', status: UserStatus.ONLINE, banned: true }),
		]);

		expect(sorted.map((user) => user.name)).toEqual(['alice', 'Bob', 'Zed', 'Aaron', 'Mira']);
	});
});
