// CLI entrypoint: `bun run helpers/seed-peer-cli.ts [--remove]`
import { ensurePeer } from './seed-peer';

await ensurePeer(process.argv.includes('--remove'));
