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
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          mingwCc = pkgs.pkgsCross.mingwW64.stdenv.cc;
          mingwPthreads = pkgs.pkgsCross.mingwW64.windows.pthreads;
        in
        {
          default = pkgs.mkShell {
            buildInputs =
              with pkgs;
              [
                nodejs
                pnpm
                bun
                tmux
                gh
                rustup
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
