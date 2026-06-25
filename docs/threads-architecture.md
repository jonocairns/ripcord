# Threads Architecture Decisions

Design notes for Discord-parity threads (epic RIP-91). These record the
hard-to-reverse choices and the reasoning behind them, so the implementation
tickets can stay terse. Discord parity was the guiding constraint; where we
diverge from Discord it is called out explicitly.

## A thread is a `channels` row

Threads are not a separate entity. `messages.channelId`, `channelReadStates`
(unread), and `channelRolePermissions` / `channelUserPermissions` are all keyed
on `channelId`, so modeling a thread as a `channels` row with `type` in the
thread set plus a `parentChannelId` lets threads reuse the entire message,
unread, permission, and realtime pipeline unchanged. This mirrors Discord, where
a thread is structurally a Channel object distinguished by `type` and `parent_id`.

The divergence: in Discord a thread created from a message reuses that message's
snowflake as the thread id (`thread.id == message.id`). Our messages and channels
are separate auto-increment id spaces, so we link them with a `parentMessageId`
foreign key instead. Functionally identical (the "X replies" affordance resolves
the thread from the message); we do not replicate the shared-id trick.

## Threads are a separate collection, not interleaved into the channel list

Although a thread *is* a channel row, it is never returned in the normal channel
list. `getChannelsForUser` returns only `parentChannelId IS NULL` rows; threads
reach the client through `THREAD_LIST_SYNC` + `THREAD_*` events into a separate
`threadsByParentChannelId` map. This matches Discord's wire protocol, where
`GUILD_CREATE` carries a `channels` array and a separate `threads` array and
threads are maintained through their own gateway events.

Consequence: the client's flat `state.channels` array, positions, categories, and
reorder logic stay untouched and cannot regress. The cost is a small seam —
`channelByIdSelector` will not find a thread, so call sites that must resolve
"either kind" use a thread-aware lookup. Discord has the same seam (a thread id
resolves against the threads cache, not the channels cache).

## Lifecycle fields are flat columns, not a JSON blob

Discord nests thread lifecycle state in a `thread_metadata` object. We store
`archived`, `archivedAt`, `locked`, `autoArchiveDuration`, `invitable`,
`lastMessageAt`, `messageCount`, `memberCount`, and `ownerId` as flat columns on
`channels`. The deciding factor is the auto-archive sweep (RIP-97), which needs an
indexed `(archived, lastMessageAt)` scan that SQLite JSON cannot serve
efficiently. Pure functional choice; no parity impact.

## Thread variants are distinct channel types

`ChannelType` gains `PUBLIC_THREAD`, `PRIVATE_THREAD`, `ANNOUNCEMENT_THREAD`,
`FORUM`, and `ANNOUNCEMENT`, matching Discord's distinct type integers. Privacy is
intrinsic to the type — we do **not** reuse the existing `channels.private`
boolean for threads, to avoid a second source of truth. The thread type set lives
behind a shared `isThreadType()` helper / `THREAD_TYPES` constant in
`packages/shared`, so the "is this a thread" predicate exists in exactly one place.

## Permissions are pure inheritance

A thread has no permission overwrites of its own, ever — matching Discord, where
per-thread overwrites do not exist. `resolveThreadPermissions(threadId)` loads the
thread, evaluates the existing `getPermissions` against `parentChannelId`, then
applies the thread-only gates: private-thread membership (`thread_members`, with
`MANAGE_THREADS` as an override), `locked` (send denied unless `MANAGE_THREADS`),
and `archived` (read-only unless the send would auto-unarchive). This removes
per-thread override resolution and any thread permission-editor UI from scope.

## Delivery and unread fall out of one audience function

Message delivery is already permission-scoped server-side:
`publishMessage` computes `getAffectedUserIdsForChannel(channelId, VIEW_CHANNEL)`
and publishes only to those users; clients subscribe to a user-scoped stream. So
private-thread leak safety and the unread-delta fanout both come for free once
`getAffectedUserIdsForChannel` is thread-aware (parent `VIEW_CHANNEL` intersected
with `thread_members` for private threads). The only new realtime wiring is the
thread-entity events, delivered with the same `publishFor(audience, …)` shape — no
new message-subscription channels.

## Unread is membership-gated and rolls up to the parent

A thread contributes to a user's unread state only if they have a `thread_members`
row (joined, auto-joined by sending, or — once mentions exist — mentioned). Thread
unread rolls up to an indicator on the parent channel in the sidebar. This keeps
`channelReadStates` from growing to (every user x every thread) and matches
Discord, which only surfaces unread for threads you participate in.

## Deferred: mention-dependent behaviors

There is currently no @-mention / ping system. Three behaviors depend on one and
are deferred until it lands: the `notificationSetting: 'mentions'` value (stored
but treated as `'none'` for now), auto-adding a user to a private thread when
mentioned, and mention-count rollup on the parent channel. Membership-gated unread
and auto-join on *send* work without it; we ship `'all'` and `'none'` now.

## Default permissions

`CREATE_PUBLIC_THREADS`, `CREATE_PRIVATE_THREADS`, and `SEND_MESSAGES_IN_THREADS`
are added to `DEFAULT_ROLE_PERMISSIONS` (on for @everyone); `MANAGE_THREADS` is
off by default. This matches both Discord's @everyone defaults and the existing
permissive baseline in `permissions.ts` where every `MANAGE_*` is off.
`CREATE_PRIVATE_THREADS` default-on is the one a self-hoster is most likely to
disable, since private threads are invisible to mods without `MANAGE_THREADS`.
