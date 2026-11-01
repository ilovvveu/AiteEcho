#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:?Set IMAGE to a locally built AiteEcho image}"
PORT="${PORT:-18082}"
PLATFORM="${PLATFORM:-linux/arm64}"
OUT_DIR="${OUT_DIR:-./run-logs/container-smoke}"
created_id=""
cleanup() {
  if [[ "$created_id" =~ ^[a-f0-9]{64}$ ]]; then docker rm -f "$created_id" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
mkdir -p "$OUT_DIR"
admin_token="$(openssl rand -hex 24)"
onebot_token="$(openssl rand -hex 24)"
created_id="$(docker run --platform "$PLATFORM" -d -p "127.0.0.1:$PORT:8080" \
  -e BOT_HOST=0.0.0.0 -e BOT_PORT=8080 -e BOT_ADMIN_TOKEN="$admin_token" \
  -e ONEBOT_MODE=reverse -e ONEBOT_REVERSE_WS_HOST=0.0.0.0 -e ONEBOT_ACCESS_TOKEN="$onebot_token" \
  -e ONEBOT_ALLOW_PRIVATE=false -e ONEBOT_ALLOW_GROUP=false -e AI_BACKEND=acp \
  -e ACP_AGENT_COMMAND=node -e 'ACP_AGENT_ARGS_JSON=["dist/examples/mock-acp-agent.js"]' \
  "$IMAGE")"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" -o "$OUT_DIR/healthz.json"; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" -o "$OUT_DIR/healthz.json"
curl -fsS -H "Authorization: Bearer $admin_token" "http://127.0.0.1:$PORT/status" -o "$OUT_DIR/status.json"
docker logs "$created_id" > "$OUT_DIR/container.log" 2>&1 || true
echo "PASS: container health only; no QQ login, no real model/TTS call, no client acceptance."
