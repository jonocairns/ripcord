import { describe, expect, it } from 'bun:test';
import { getTrpcErrorData, isNonRetriableTrpcError } from '../trpc-error-data';

describe('getTrpcErrorData', () => {
  it('extracts typed code and http status values', () => {
    expect(
      getTrpcErrorData({
        data: {
          code: 'FORBIDDEN',
          httpStatus: 403
        }
      })
    ).toEqual({
      code: 'FORBIDDEN',
      httpStatus: 403
    });
  });

  it('ignores non-object error payloads', () => {
    expect(getTrpcErrorData(new Error('boom'))).toBeUndefined();
    expect(getTrpcErrorData({ data: 'bad-shape' })).toBeUndefined();
  });
});

describe('isNonRetriableTrpcError', () => {
  it('treats 4xx-style tRPC failures as terminal', () => {
    expect(
      isNonRetriableTrpcError({
        data: {
          code: 'FORBIDDEN',
          httpStatus: 403
        }
      })
    ).toBe(true);

    expect(
      isNonRetriableTrpcError({
        data: {
          code: 'NOT_FOUND'
        }
      })
    ).toBe(true);
  });

  it('allows retries for non-tRPC and server-side failures', () => {
    expect(isNonRetriableTrpcError(new Error('boom'))).toBe(false);

    expect(
      isNonRetriableTrpcError({
        data: {
          code: 'INTERNAL_SERVER_ERROR',
          httpStatus: 500
        }
      })
    ).toBe(false);
  });
});
