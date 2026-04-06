const getEnvelopeHeaderDsn = (body: Uint8Array): string | undefined => {
  const firstLine = Buffer.from(body).toString('utf8').split('\n')[0];

  if (!firstLine) {
    return undefined;
  }

  try {
    const parsedHeader: unknown = JSON.parse(firstLine);

    if (
      typeof parsedHeader !== 'object' ||
      parsedHeader === null ||
      !('dsn' in parsedHeader)
    ) {
      return undefined;
    }

    const { dsn } = parsedHeader;

    return typeof dsn === 'string' && dsn.trim() ? dsn.trim() : undefined;
  } catch {
    return undefined;
  }
};

export { getEnvelopeHeaderDsn };
