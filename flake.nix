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
          mingwPrefix = mingwCc.targetPrefix;
          mingwPthreads =
            if pkgs.pkgsCross.mingwW64.windows ? pthreads then
              pkgs.pkgsCross.mingwW64.windows.pthreads
            else if pkgs.pkgsCross.mingwW64.windows ? mingw_w64_pthreads then
              pkgs.pkgsCross.mingwW64.windows.mingw_w64_pthreads
            else
              null;
          mingwPthreadLib =
            if mingwPthreads != null then "${mingwPthreads}/lib/libpthread.a" else "";
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
                mingwCc
              ]
              ++ nixpkgs.lib.optionals (mingwPthreads != null) [ mingwPthreads ]
              ++ nixpkgs.lib.optionals pkgs.stdenv.isLinux [
                docker
                docker-compose
              ];

            shellHook = ''
              export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=${mingwPrefix}gcc
              export CC_x86_64_pc_windows_gnu=${mingwPrefix}gcc
              export CXX_x86_64_pc_windows_gnu=${mingwPrefix}g++
              export AR_x86_64_pc_windows_gnu=${mingwPrefix}ar

              # Rust's x86_64-pc-windows-gnu std expects libpthread.a. Some MinGW
              # toolchains only ship libwinpthread.a, so provide a shim path.
              mingw_libgcc="$(${mingwPrefix}gcc -print-libgcc-file-name 2>/dev/null || true)"
              mingw_libdir=""
              mingw_root=""
              if [ -n "$mingw_libgcc" ] && [ -f "$mingw_libgcc" ]; then
                mingw_libdir="$(dirname "$mingw_libgcc")"
                mingw_root="$(cd "$mingw_libdir/../../../../" >/dev/null 2>&1 && pwd || true)"
              fi

              gcc_search_dirs="$(${mingwPrefix}gcc -print-search-dirs 2>/dev/null | sed -n 's/^libraries: =//p' | tr ':' '\n')"

              rust_link_dirs=""
              for d in \
                "$mingw_libdir" \
                "$mingw_root/x86_64-w64-mingw32/lib" \
                "$mingw_root/lib" \
                $gcc_search_dirs; do
                if [ -n "$d" ] && [ -d "$d" ]; then
                  rust_link_dirs="$rust_link_dirs -Lnative=$d"
                fi
              done

              pthread_src=""
              if [ -f "${mingwPthreadLib}" ]; then
                pthread_src="${mingwPthreadLib}"
              fi

              if [ -z "$pthread_src" ]; then
                for probe_dir in \
                  "$mingw_libdir" \
                  "$mingw_libdir/../lib" \
                  "$mingw_libdir/../../lib" \
                  "$mingw_root/x86_64-w64-mingw32/lib" \
                  "$mingw_root/lib" \
                  $gcc_search_dirs; do
                  [ -d "$probe_dir" ] || continue
                  for candidate_name in libpthread.a libwinpthread.a libwinpthread.dll.a; do
                    candidate_path="$probe_dir/$candidate_name"
                    if [ -f "$candidate_path" ]; then
                      pthread_src="$candidate_path"
                      break 2
                    fi
                  done
                done
              fi

              if [ -z "$pthread_src" ] && [ "''${SHARKORD_ALLOW_NIX_STORE_SCAN:-0}" = "1" ]; then
                pthread_src="$(find /nix/store -type f \
                  \( -name libpthread.a -o -name libwinpthread.a -o -name libwinpthread.dll.a \) \
                  2>/dev/null | head -n 1)"
              fi

              if [ -n "$pthread_src" ]; then
                pthread_libdir="$(dirname "$pthread_src")"
                pthread_basename="$(basename "$pthread_src")"
                extra_link_dir="$pthread_libdir"

                if [ "$pthread_basename" != "libpthread.a" ]; then
                  pthread_dir="''${TMPDIR:-/tmp}/sharkord-mingw-lib"
                  mkdir -p "$pthread_dir"
                  ln -sf "$pthread_src" "$pthread_dir/libpthread.a"
                  extra_link_dir="$pthread_dir"
                fi

                export LIBRARY_PATH="$extra_link_dir:$pthread_libdir''${LIBRARY_PATH:+:$LIBRARY_PATH}"
                extra_rustflags="-Lnative=$extra_link_dir -Lnative=$pthread_libdir$rust_link_dirs"
                export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="$extra_rustflags''${CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS:+ $CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS}"
              elif [ -n "$rust_link_dirs" ]; then
                export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="$rust_link_dirs''${CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS:+ $CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS}"
              fi
            '';
          };
        }
      );
    };
}
