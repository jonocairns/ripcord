import { validateReleaseMetadata } from './helpers';
import { type TOptions, type TOverrides } from './types';
declare class BunUpdater {
    private owner;
    private repo;
    private channel;
    private currentVersion;
    private isUpdating;
    private autoStart;
    private ignoreChecksum;
    constructor(options: TOptions);
    private getLatestRelease;
    getLatestVersion: () => Promise<string>;
    hasUpdates: () => Promise<boolean>;
    checkForUpdates: (options?: TOverrides) => Promise<void>;
}
export type { TRelease, TReleaseMetadata } from './types';
export { BunUpdater, validateReleaseMetadata };
//# sourceMappingURL=index.d.ts.map