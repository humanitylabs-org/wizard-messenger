#!/bin/sh
# Reviewed static manifest, never sourced. Requires only POSIX sh and coreutils.
# check MANIFEST PROVENANCE PATCH_DIR
# admit MANIFEST PROVENANCE PATCH_DIR TARGETARCH BIN_DIR OUT_DIR
set -eu

refuse() {
    printf '%s\n' "Engine admission refused: $*. Use a source build with the default MDK_BUILD_IMAGE=rust:1.97.1-bookworm (no prebuilt wn/wnd)." >&2
    exit 1
}

valid_hash() {
    [ "${#1}" -eq 64 ] || refuse 'missing or malformed SHA-256'
    case "$1" in *[!0-9a-f]*) refuse 'malformed SHA-256' ;; esac
}

verify_hash() {
    [ -f "$1" ] && [ ! -L "$1" ] || refuse "missing or symlinked file: $1"
    actual=$(sha256sum "$1") || refuse "cannot hash $1"
    [ "${actual%% *}" = "$2" ] || refuse "SHA-256 mismatch: $1"
}

mode=${1-}
case "$mode:$#" in check:4|admit:7) ;; *) refuse 'invalid helper arguments' ;; esac
manifest=$2
provenance=$3
patch_dir=$4
arch=${5-}
[ -r "$manifest" ] || refuse 'missing manifest'
provenance_hash=
patch_name=
patch_hash=
amd64_wn=
amd64_wnd=
arm64_wn=
arm64_wnd=
while read -r kind a b c extra || [ -n "$kind$a$b$c$extra" ]; do
    case "$kind" in
        ''|'#'*) continue ;;
        provenance)
            [ -z "$provenance_hash$b$c$extra" ] || refuse 'duplicate or malformed provenance row'
            valid_hash "$a"
            provenance_hash=$a
            ;;
        patch)
            # This admission version intentionally supports exactly one source patch.
            [ -z "$patch_name$c$extra" ] || refuse 'duplicate or malformed patch row'
            case "$a" in ''|*[!a-zA-Z0-9_.-]*|.*) refuse 'unsafe patch basename' ;; esac
            case "$a" in *.patch) ;; *) refuse 'invalid patch filename' ;; esac
            valid_hash "$b"
            patch_name=$a
            patch_hash=$b
            ;;
        binary)
            [ -z "$extra" ] || refuse 'malformed binary row'
            valid_hash "$b"
            valid_hash "$c"
            case "$a" in
                amd64)
                    [ -z "$amd64_wn" ] || refuse 'duplicate amd64 row'
                    amd64_wn=$b; amd64_wnd=$c ;;
                arm64)
                    [ -z "$arm64_wn" ] || refuse 'duplicate arm64 row'
                    arm64_wn=$b; arm64_wnd=$c ;;
                *) refuse "unknown manifest architecture: $a" ;;
            esac
            ;;
        *) refuse 'unknown manifest row' ;;
    esac
done < "$manifest"
[ -n "$provenance_hash" ] && [ -n "$patch_name" ] || refuse 'incomplete manifest'
verify_hash "$provenance" "$provenance_hash"
# Match the entire set consumed by Docker's git am /patches/*.patch, not just one digest.
for path in "$patch_dir"/*.patch; do
    [ "$path" = "$patch_dir/$patch_name" ] || refuse 'unexpected or missing source patch'
    verify_hash "$path" "$patch_hash"
done
[ "$mode" = admit ] || exit 0

case "$arch" in
    amd64) wn_hash=$amd64_wn; wnd_hash=$amd64_wnd ;;
    arm64) wn_hash=$arm64_wn; wnd_hash=$arm64_wnd ;;
    *) refuse "unknown or missing target architecture: $arch" ;;
esac
[ -n "$wn_hash" ] && [ -n "$wnd_hash" ] || refuse "no patched hashes for $arch"
bin_dir=$6
out_dir=$7
# Validate both before copying either. Never execute a carrier's binaries to admit them.
for name in wn wnd; do
    [ -f "$bin_dir/$name" ] && [ -x "$bin_dir/$name" ] || refuse "missing or nonexecutable $name"
done
verify_hash "$bin_dir/wn" "$wn_hash"
verify_hash "$bin_dir/wnd" "$wnd_hash"
cp "$bin_dir/wn" "$bin_dir/wnd" "$out_dir/" || refuse 'cannot copy admitted pair'
printf '%s\n' "Admitted patched $arch wn/wnd; runtime coverage is recorded separately in provenance."
