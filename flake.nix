{
  description = "Nodejs flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      self,
      nixpkgs,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f (import nixpkgs {
            inherit system;
          })
        );
      # Pin Bun independently of nixpkgs, which lags Bun security releases.
      # Release server binaries embed this exact runtime (see
      # apps/server/build/helpers.ts), so keep it in step with CI's
      # bun-version and the Dockerfile. 1.4.4 carries the Brotli fix for
      # CVE-2026-111497. Hashes match the release's SHASUMS256.txt.
      bunVersion = "1.4.4";
      bunReleaseAssets = {
        x86_64-linux = {
          name = "bun-linux-x64";
          hash = "sha256-v4zL+ysLgBWeD5ptFcVTF63YB3U028YTCj7bUvzLOVw=";
        };
        aarch64-darwin = {
          name = "bun-darwin-aarch64";
          hash = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
        };
      };
      pinnedBun =
        pkgs:
        let
          asset = bunReleaseAssets.${pkgs.stdenv.hostPlatform.system};
        in
        pkgs.bun.overrideAttrs (_: {
          version = bunVersion;
          src = pkgs.fetchurl {
            url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${asset.name}.zip";
            inherit (asset) hash;
          };
        });
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          bun = pinnedBun pkgs;
          mingwCc = pkgs.pkgsCross.mingwW64.stdenv.cc;
          mingwPthreads = pkgs.pkgsCross.mingwW64.windows.pthreads;
        in
        {
          # Server binaries are compiled by Bun, including Windows targets.
          # Keep desktop toolchains out of the server release environment.
          server-release = pkgs.mkShell {
            buildInputs = with pkgs; [
              nodejs
              bun
            ];
          };

          default = pkgs.mkShell {
            buildInputs =
              with pkgs;
              [
                nodejs
                bun
                tmux
                gh
                rustup
                ripgrep
              ]
              ++ nixpkgs.lib.optionals pkgs.stdenv.isLinux [
                mingwCc
                mingwPthreads
                docker
                docker-compose
              ];

            shellHook = nixpkgs.lib.optionalString pkgs.stdenv.isLinux ''
              export CC_x86_64_pc_windows_gnu=${mingwCc.targetPrefix}gcc
              export CXX_x86_64_pc_windows_gnu=${mingwCc.targetPrefix}g++
              export AR_x86_64_pc_windows_gnu=${mingwCc.targetPrefix}ar
              export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="-Lnative=${mingwCc.cc}/lib/gcc/x86_64-w64-mingw32/${mingwCc.cc.version} -Lnative=${mingwCc.cc}/x86_64-w64-mingw32/lib -Lnative=${mingwPthreads}/lib"
            '';
          };
        }
      );
    };
}
