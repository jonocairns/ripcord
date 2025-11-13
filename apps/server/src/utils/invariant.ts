import { TRPCError } from '@trpc/server';

const invariant: (
  condition: unknown,
  trpcData: ConstructorParameters<typeof TRPCError>[0]
) => asserts condition = (condition, trpcData) => {
  if (!condition) {
    throw new TRPCError(trpcData);
  }
};

export { invariant };
