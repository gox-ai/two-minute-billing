#!/usr/bin/env bash
# Build the two self-host images (engine, dashboard) for linux/amd64 and linux/arm64.
# The release workflow (.github/workflows/images-publish.yml) runs this on every tag; it also
# runs by hand, from the repository root of the public tree.
#
#   deploy/docker/build-images.sh 0.1.1                  # build only (cache), nothing pushed
#   deploy/docker/build-images.sh 0.1.1 --push           # build and push, with SBOM + provenance
#   deploy/docker/build-images.sh 0.1.1 --push --sign    # then cosign-sign each image by digest
#
# Needs `docker buildx` with a builder that supports both platforms (docker-container driver,
# QEMU for arm64), `docker login ghcr.io` to push, and `cosign` to sign. Keyless signing uses
# the ambient identity (the workflow's OIDC token in CI); COSIGN_KEY names a key file instead.
set -Eeuo pipefail

VERSION="${1:-}"
shift || true
PUSH=0 SIGN=0
for a in "$@"; do
  case "$a" in
    --push) PUSH=1 ;;
    --sign) SIGN=1 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] \
  || { echo "usage: $0 X.Y.Z [--push] [--sign]" >&2; exit 2; }
[ "$SIGN" = 0 ] || [ "$PUSH" = 1 ] || { echo "--sign needs --push (it signs the pushed digest)" >&2; exit 2; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PREFIX="${IMAGE_PREFIX:-ghcr.io/gox-ai/two-minute-billing}"
SOURCE_URL="${IMAGE_SOURCE_URL:-https://github.com/gox-ai/two-minute-billing}"

for name in engine dashboard; do
  ref="$PREFIX-$name:$VERSION"
  meta="$(mktemp)"
  if [ "$PUSH" = 1 ]; then
    # Attestations need an image exporter, so they ride only on a push.
    out=(--push --sbom=true --provenance=mode=max --metadata-file "$meta")
  else
    out=(--output type=cacheonly)
  fi
  echo "==> $ref ($([ "$PUSH" = 1 ] && echo push || echo build only))"
  docker buildx build --platform linux/amd64,linux/arm64 \
    --label "org.opencontainers.image.source=$SOURCE_URL" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.licenses=AGPL-3.0-only" \
    -f "$ROOT/deploy/docker/Dockerfile.$name" -t "$ref" \
    "${out[@]}" "$ROOT"
  if [ "$PUSH" = 1 ]; then
    digest="$(sed -n 's/.*"containerimage.digest": *"\([^"]*\)".*/\1/p' "$meta")"
    [ -n "$digest" ] || { echo "no digest for $ref" >&2; exit 1; }
    echo "    pushed $ref@$digest"
    if [ "$SIGN" = 1 ]; then
      cosign sign --yes ${COSIGN_KEY:+--key "$COSIGN_KEY"} "$PREFIX-$name@$digest"
      echo "    signed $PREFIX-$name@$digest"
    fi
  fi
  rm -f "$meta"
done
