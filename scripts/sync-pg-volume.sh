#!/usr/bin/env bash
# 로컬에서 한 번 실행: 기존 폴더별 Docker 볼륨(예: infovi0403_infovi_pgdata) 데이터를
# 공유 볼륨 infovi_viz_pgdata로 복사합니다. docker compose의 name: infovi_viz_pgdata 와 짝입니다.
set -euo pipefail
SHARED_VOL="infovi_viz_pgdata"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: $0 [SOURCE_VOLUME]"
  echo "  Copy SOURCE_VOLUME -> ${SHARED_VOL} (creates target only if it does not exist)."
  echo "  Example: $0 infovi0403_infovi_pgdata"
  echo "  List: docker volume ls | grep infovi"
  exit 0
fi

if docker volume inspect "$SHARED_VOL" &>/dev/null; then
  echo "${SHARED_VOL} already exists."
  echo "To re-copy: docker compose down, docker volume rm ${SHARED_VOL}, then run this script again."
  exit 0
fi

SRC="${1:-}"
if [[ -z "$SRC" ]]; then
  echo "Available volumes (pick the one that already has your Postgres data):"
  docker volume ls
  echo ""
  echo "Then: yarn sync-pg-volume <volume_name>"
  echo "Often: infovi0403_infovi_pgdata"
  exit 1
fi

if ! docker volume inspect "$SRC" &>/dev/null; then
  echo "Unknown volume: $SRC"
  exit 1
fi

docker volume create "$SHARED_VOL"
docker run --rm \
  -v "$SRC":/from:ro \
  -v "$SHARED_VOL":/to \
  alpine:3.20 \
  sh -c 'cd /from && cp -a . /to'
echo "OK: $SRC -> $SHARED_VOL"
echo "Next: docker compose up -d (from InfoVi0403 or InfoVi0403Test)"
