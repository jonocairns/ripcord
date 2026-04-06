const getSentryEnvelopeForwardUrl = (dsn: string): string => {
  const parsedDsn = new URL(dsn);
  const pathSegments = parsedDsn.pathname.split('/').filter(Boolean);
  const projectId = pathSegments.pop();

  if (!projectId) {
    throw new Error('Sentry DSN is missing a project ID.');
  }

  const basePath = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';

  return `${parsedDsn.protocol}//${parsedDsn.host}${basePath}/api/${projectId}/envelope/`;
};

export { getSentryEnvelopeForwardUrl };
