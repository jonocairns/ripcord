import { describe, expect, test } from 'bun:test';
import { channels, messages, roles, settings, users } from '../db/schema';
import { getTestDb } from './mock-db';

describe('tests setup', () => {
  test('should seed database with initial data', async () => {
    const db = getTestDb();

    const [
      settingsResults,
      usersResults,
      channelsResults,
      rolesResults,
      messagesResults
    ] = await Promise.all([
      db.select().from(settings),
      db.select().from(users),
      db.select().from(channels),
      db.select().from(roles),
      db.select().from(messages)
    ]);

    expect(settingsResults.length).toBe(1);
    expect(usersResults.length).toBe(2);
    expect(channelsResults.length).toBe(2);
    expect(rolesResults.length).toBe(3);
    expect(messagesResults.length).toBe(1);
  });
});
