import z from 'zod';
declare enum ETarget {
    LINUX_X64 = "linux-x64",
    LINUX_ARM64 = "linux-arm64",
    WINDOWS_X64 = "windows-x64",
    DARWIN_ARM64 = "darwin-arm64",
    DARWIN_X64 = "darwin-x64"
}
declare const zArtifact: z.ZodObject<{
    name: z.ZodString;
    target: z.ZodEnum<typeof ETarget>;
    size: z.ZodNumber;
    checksum: z.ZodString;
}, z.core.$strip>;
declare const zRelease: z.ZodObject<{
    version: z.ZodString;
    releaseDate: z.ZodString;
    artifacts: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        target: z.ZodEnum<typeof ETarget>;
        size: z.ZodNumber;
        checksum: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
type TArtifact = z.infer<typeof zArtifact>;
type TReleaseMetadata = z.infer<typeof zRelease>;
type TOptions = {
    repoOwner: string;
    repoName: string;
    channel?: string;
    currentVersion?: string;
    autoStart?: boolean;
    ignoreChecksum?: boolean;
};
type TOverrides = {
    autoStart?: boolean;
};
type TAsset = {
    name: string;
    browser_download_url: string;
    url: string;
    size: number;
    digest: string;
};
type TRelease = {
    tag_name: string;
    published_at: string;
    assets: Array<TAsset>;
};
export { ETarget, zArtifact, zRelease };
export type { TArtifact, TAsset, TOptions, TOverrides, TRelease, TReleaseMetadata };
//# sourceMappingURL=types.d.ts.map