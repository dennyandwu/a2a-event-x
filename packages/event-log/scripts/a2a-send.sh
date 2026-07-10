#!/usr/bin/env bash
# a2a-send.sh — A2A 消息统一发送入口 (Phase 2)
# 用法:
#   a2a-send.sh --from satoshi --to elon --topic proj-012 --type task.dispatch \
#               --summary "审核请求" --doc-path "path/to/doc.md" \
#               --next ansen --prev issac --priority P0 \
#               [--correlation-id xxx] [--context-channel-id <discord-channel-or-thread-id>] \
#               [--result-channel <discord-channel-or-thread-id>] [--closeout-policy <required|optional|none>] \
#               [--wake | --no-wake]
#
# 行为：
#   1. 写入 Event Log（a2a-log.py write）— 持久化消息本体（source of truth）
#   2. 默认由 a2a-log.py 内部 Hook-C 在写入成功后主动唤醒下游读取 pending
#   3. `--wake` 仅保留为手动/兼容开关，不再是默认主触发器
#
# Phase 2.3 变更：
#   - Event Log 是 A2A 消息的唯一 source of truth
#   - Hook-C（post-write notify）成为主触发器
#   - Heartbeat 退回补偿/巡查层
#   - `--wake` 失败不影响主流程（Event Log 已写入）
#   - 若提供 --context-channel-id，则优先路由到目标 agent 在该频道/线程中的上下文 session；不存在时再回退主频道
#
# 版本: v2.3 (Event Log Hook-C primary trigger)

set -euo pipefail

# ── 颜色输出 ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info()  { echo -e "${BLUE}[a2a-send]${NC} $*" >&2; }
log_ok()    { echo -e "${GREEN}[a2a-send]${NC} $*" >&2; }
log_warn()  { echo -e "${YELLOW}[a2a-send WARN]${NC} $*" >&2; }
log_err()   { echo -e "${RED}[a2a-send ERR]${NC} $*" >&2; }

# ── Agent SessionKey / SessionId / Display Label 映射 ─────────────────────────
ROUTING_HELPER="${HOME}/.openclaw/scripts/a2a_routing.py"

get_session_key() {
    local agent="$1"
    local context_channel_id="${2:-}"
    if [[ -n "$context_channel_id" ]]; then
        python3 "$ROUTING_HELPER" resolve-session-key "$agent" --context-channel-id "$context_channel_id" 2>/dev/null || true
    else
        python3 "$ROUTING_HELPER" session-key "$agent" 2>/dev/null || true
    fi
}

get_session_store_path() {
    local agent="$1"
    python3 "$ROUTING_HELPER" session-store "$agent" 2>/dev/null || true
}

get_display_label() {
    local agent="$1"
    local context_channel_id="${2:-}"
    if [[ -n "$context_channel_id" ]]; then
        python3 "$ROUTING_HELPER" resolve-label "$agent" --context-channel-id "$context_channel_id" --short 2>/dev/null || true
    else
        python3 "$ROUTING_HELPER" label "$agent" --short 2>/dev/null || true
    fi
}

get_session_id() {
    local agent="$1"
    local session_key="$2"
    local store
    store=$(get_session_store_path "$agent")
    [[ -z "$store" || ! -f "$store" ]] && return 1

    python3 - "$store" "$session_key" <<'PY'
import json, sys
store_path, session_key = sys.argv[1], sys.argv[2]
with open(store_path) as f:
    data = json.load(f)
entry = data.get(session_key, {}) if isinstance(data, dict) else {}
sid = entry.get('sessionId')
if sid:
    print(sid)
    sys.exit(0)
sys.exit(1)
PY
}

# ── 参数默认值 ────────────────────────────────────────────────────────────────
FROM=""
TO=""
TOPIC=""
TYPE=""
SUMMARY=""
DOC_PATH=""
NEXT="END"
PREV="origin"
PRIORITY="P1"
CORRELATION_ID=""
CONTEXT_CHANNEL_ID=""
RESULT_CHANNEL=""
CLOSEOUT_POLICY=""
WAKE=false
EXTRA_ARGS=()

# ── 参数解析 ──────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --from)           FROM="$2"; shift 2 ;;
        --to)             TO="$2"; shift 2 ;;
        --topic)          TOPIC="$2"; shift 2 ;;
        --type)           TYPE="$2"; shift 2 ;;
        --summary)        SUMMARY="$2"; shift 2 ;;
        --doc-path)       DOC_PATH="$2"; shift 2 ;;
        --next)           NEXT="$2"; shift 2 ;;
        --prev)           PREV="$2"; shift 2 ;;
        --priority)       PRIORITY="$2"; shift 2 ;;
        --correlation-id) CORRELATION_ID="$2"; shift 2 ;;
        --context-channel-id) CONTEXT_CHANNEL_ID="$2"; shift 2 ;;
        --result-channel) RESULT_CHANNEL="$2"; shift 2 ;;
        --closeout-policy) CLOSEOUT_POLICY="$2"; shift 2 ;;
        --wake)           WAKE=true; shift ;;
        --no-wake)        WAKE=false; shift ;;
        *)
            log_warn "未知参数: $1，传递给 a2a-log.py"
            EXTRA_ARGS+=("$1")
            shift
            ;;
    esac
done

# ── 必填参数检查 ──────────────────────────────────────────────────────────────
MISSING=()
[[ -z "$FROM" ]]  && MISSING+=("--from")
[[ -z "$TO" ]]    && MISSING+=("--to")
[[ -z "$TOPIC" ]] && MISSING+=("--topic")
[[ -z "$TYPE" ]]  && MISSING+=("--type")

if [[ ${#MISSING[@]} -gt 0 ]]; then
    log_err "缺少必填参数: ${MISSING[*]}"
    echo ""
    echo "用法: a2a-send.sh --from <agent> --to <agent> --topic <topic> --type <type>"
    echo "                   --summary <text> [--doc-path <path>]"
    echo "                   [--next <agent|END>] [--prev <agent>] [--priority P0|P1|P2]"
    echo "                   [--correlation-id <id>] [--wake | --no-wake]"
    exit 1
fi

# ── Doc-First 校验 ────────────────────────────────────────────────────────────
DOC_FIRST_SUMMARY_MAX=200
SUMMARY_LEN=${#SUMMARY}
if [[ $SUMMARY_LEN -gt $DOC_FIRST_SUMMARY_MAX && -z "$DOC_PATH" ]]; then
    log_err "Doc-First: --summary 超过 ${DOC_FIRST_SUMMARY_MAX} 字符 (当前 ${SUMMARY_LEN})，必须提供 --doc-path"
    log_err "  请将完整内容写入 Obsidian Vault Markdown，然后用 --doc-path 引用"
    exit 1
fi

A2A_LOG="python3 ${HOME}/.openclaw/scripts/a2a-log.py"

# ── 构建 payload JSON ─────────────────────────────────────────────────────────
PAYLOAD_PARTS=()
[[ -n "$SUMMARY" ]]  && PAYLOAD_PARTS+=("\"summary\": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$SUMMARY")")
[[ -n "$DOC_PATH" ]] && PAYLOAD_PARTS+=("\"doc_path\": $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$DOC_PATH")")

# 组合 payload
if [[ ${#PAYLOAD_PARTS[@]} -gt 0 ]]; then
    PAYLOAD="{$(IFS=', '; echo "${PAYLOAD_PARTS[*]}")}"
else
    PAYLOAD='{"summary": ""}'
fi

# ── Doc-First: payload 总长度检查（shell 层 warn，Python 层 reject）────────────
PAYLOAD_LEN=${#PAYLOAD}
if [[ $PAYLOAD_LEN -gt 500 && -z "$DOC_PATH" ]]; then
    log_warn "Doc-First: payload 总长度 ${PAYLOAD_LEN} > 500，建议提供 --doc-path"
fi

# ── 步骤 1：写入 Event Log ────────────────────────────────────────────────────
log_info "写入 Event Log (source of truth)..."
log_info "  from=$FROM to=$TO topic=$TOPIC type=$TYPE priority=$PRIORITY"

CMD_ARGS=(
    "write"
    "--from" "$FROM"
    "--to"   "$TO"
    "--topic" "$TOPIC"
    "--type"  "$TYPE"
    "--payload" "$PAYLOAD"
    "--prev" "$PREV"
    "--next" "$NEXT"
    "--priority" "$PRIORITY"
)

[[ -n "$CORRELATION_ID" ]] && CMD_ARGS+=("--correlation-id" "$CORRELATION_ID")
if [[ -n "$CONTEXT_CHANNEL_ID" ]]; then
    if [[ -n "$RESULT_CHANNEL" ]]; then
        CMD_ARGS+=("--result-channel" "$RESULT_CHANNEL" "--origin-context-channel-id" "$CONTEXT_CHANNEL_ID")
    else
        CMD_ARGS+=("--result-channel" "$CONTEXT_CHANNEL_ID" "--origin-context-channel-id" "$CONTEXT_CHANNEL_ID")
    fi
elif [[ -n "$RESULT_CHANNEL" ]]; then
    CMD_ARGS+=("--result-channel" "$RESULT_CHANNEL")
fi
[[ -n "$CLOSEOUT_POLICY" ]] && CMD_ARGS+=("--closeout-policy" "$CLOSEOUT_POLICY")
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    CMD_ARGS+=("${EXTRA_ARGS[@]}")
fi

WRITE_OUTPUT=""
if WRITE_OUTPUT=$(${A2A_LOG} "${CMD_ARGS[@]}" 2>&1); then
    log_ok "Event Log 写入成功"
    echo "$WRITE_OUTPUT"
else
    log_err "Event Log 写入失败！"
    echo "$WRITE_OUTPUT"
    exit 1
fi

# ── 步骤 2：发送 wake signal（Phase 2 降级行为）─────────────────────────────
if [[ "$WAKE" == "true" ]]; then
    TARGET_SESSION=$(get_session_key "$TO" "$CONTEXT_CHANNEL_ID")
    TARGET_LABEL=$(get_display_label "$TO" "$CONTEXT_CHANNEL_ID")

    if [[ -z "$TARGET_SESSION" ]]; then
        log_warn "未知 agent '$TO'，跳过 wake signal（Event Log 已写入，不影响主流程）"
    else
        WAKE_MSG="[Event Log Wake] 新 ${TYPE} from ${FROM} | topic: ${TOPIC} | 执行 a2a-log.py pending --agent ${TO}"
        TARGET_SESSION_ID=""
        if TARGET_SESSION_ID=$(get_session_id "$TO" "$TARGET_SESSION" 2>/dev/null); then
            if [[ -n "$TARGET_LABEL" ]]; then
                log_info "发送 wake signal → $TO [$TARGET_LABEL] ($TARGET_SESSION | sessionId=$TARGET_SESSION_ID)"
            else
                log_info "发送 wake signal → $TO ($TARGET_SESSION | sessionId=$TARGET_SESSION_ID)"
            fi
            log_info "  wake msg: $WAKE_MSG"

            # 用当前可用 CLI：openclaw agent --session-id
            # 注意：这是完整 agent turn，会阻塞等待结果；wake 语义应为异步 best-effort。
            # 因此改为后台投递，只要成功 spawn 即视为 wake 已发出。
            WAKE_LOG="/tmp/openclaw-a2a-wake-${TO}.log"
            if nohup openclaw agent \
                --session-id "$TARGET_SESSION_ID" \
                --message "$WAKE_MSG" \
                --timeout 30 \
                --json >"$WAKE_LOG" 2>&1 </dev/null & then
                log_ok "Wake signal 已后台投递"
            else
                log_warn "Wake signal 后台投递失败（Event Log 已写入，target agent 会在下次 heartbeat 时检测到）"
            fi
        else
            log_warn "未找到 $TO 的 sessionId，跳过 wake signal（Event Log 已写入，不影响主流程）"
        fi
    fi
else
    log_info "默认不再发送额外 wake：由 Event Log Hook-C 作为主触发器；Heartbeat 负责补偿巡查"
fi

log_ok "a2a-send 完成 [Phase 2.3 mode: Event Log = source of truth, Hook-C = primary trigger]"
