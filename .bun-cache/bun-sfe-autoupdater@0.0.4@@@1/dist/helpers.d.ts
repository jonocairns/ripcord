import { ETarget, type TAsset } from './types';
declare const getGithubHeaders: () => Record<string, string>;
declare const downloadAsset: (asset: TAsset) => Promise<Response>;
declare const getLibVersion: () => Promise<string>;
declare const downloadUpdater: () => Promise<string>;
declare const getCurrentArchitecture: () => ETarget;
declare const validateReleaseMetadata: (releaseMetadata: any) => {
    version: string;
    releaseDate: string;
    artifacts: {
        name: string;
        target: ETarget;
        size: number;
        checksum: string;
    }[];
};
export { downloadAsset, downloadUpdater, getCurrentArchitecture, getGithubHeaders, getLibVersion, validateReleaseMetadata };
//# sourceMappingURL=helpers.d.ts.map