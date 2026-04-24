import chalk from 'chalk';
import { config, SERVER_PRIVATE_IPS, SERVER_PUBLIC_IPS } from '../config';
import { formatResolvedIpAddresses } from '../helpers/ip-addresses';
import * as serverPaths from '../helpers/paths';
import * as envVars from './env';

const printDebug = () => {
  if (!config.server.debug) return;

  const message = [
    chalk.dim('────────────────────────────────────────────────────'),
    `${chalk.blue('Bun version:')} ${chalk.bold(String(Bun.version_with_sha))}`,
    `${chalk.blue('Local addresses:')} ${chalk.bold(
      formatResolvedIpAddresses(SERVER_PRIVATE_IPS)
    )}`,
    `${chalk.blue('Public addresses:')} ${chalk.bold(
      formatResolvedIpAddresses(SERVER_PUBLIC_IPS)
    )}`,
    `${chalk.blue('Server paths:')} ${chalk.bold(
      String(
        Object.entries(serverPaths)
          .map(([key, value]) => `\n  ${key}: ${value}`)
          .join('')
      )
    )}`,
    `${chalk.blue('Config:')} ${chalk.bold(
      String(JSON.stringify(config, null, 2))
    )}`,
    `${chalk.blue('Environment Variables:')} ${chalk.bold(
      String(
        Object.entries(envVars)
          .map(([key, value]) => `\n  ${key}: ${value}`)
          .join('')
      )
    )}`
  ].join('\n');

  console.log('%s', message);
  console.log(
    chalk.dim('────────────────────────────────────────────────────')
  );
  console.log(
    chalk.white.bold('Debug mode is enabled. This may affect performance.')
  );
};

export { printDebug };
