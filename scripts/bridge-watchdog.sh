#!/bin/bash
# 飞书桥看门狗 v3：每2分钟检查一次，发现桥失联自动重启
# 检查项：1) 服务在运行 2) 有到飞书的 TCP 连接 3) 新增日志里连接卡住且未恢复
# v2 改进：只看自上次检查以来新增的日志行，避免旧日志误触发
# v3 改进：同时看守 claude 和 antigravity 两个 profile

check_profile() {
    local PROFILE="$1"
    local SERVICE="lark-channel-bridge.bot.${PROFILE}.service"
    local LOG_DIR="$HOME/.lark-channel/profiles/${PROFILE}/logs/daemon"
    local WATCHDOG_LOG="$LOG_DIR/watchdog.log"
    local STATE_FILE="/tmp/bridge-watchdog-state-${PROFILE}"

    log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$WATCHDOG_LOG"; }
    restart_bridge() {
        log "重启桥服务：$1"
        systemctl --user restart "$SERVICE"
        sleep 5
        if systemctl --user is-active --quiet "$SERVICE"; then
            log "重启成功，服务已恢复"
        else
            log "重启失败！服务仍未运行"
        fi
    }

    # 1. 服务是否在运行
    if ! systemctl --user is-active --quiet "$SERVICE"; then
        restart_bridge "服务未运行"
        return 0
    fi

    # 2. 是否有到代理的 TCP 连接（桥通过本地代理连飞书）
    local PID=$(systemctl --user show "$SERVICE" --property=MainPID --value)
    if [ -n "$PID" ] && [ "$PID" != "0" ]; then
        if ! ss -tnp 2>/dev/null | grep -q "pid=$PID"; then
            restart_bridge "进程存活但无 TCP 连接"
            return 0
        fi
    fi

    # 3. 新增日志里连接卡住且未恢复（只看上次检查之后新增的行）
    local STDERR_LOG="$LOG_DIR/daemon-stderr.log"
    local STDOUT_LOG="$LOG_DIR/daemon-stdout.log"
    if [ -f "$STDERR_LOG" ]; then
        local CUR_LINES=$(wc -l < "$STDERR_LOG")
        local PREV_LINES=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
        echo "$CUR_LINES" > "$STATE_FILE"
        if [ "$CUR_LINES" -gt "$PREV_LINES" ]; then
            local NEW_LINES=$((CUR_LINES - PREV_LINES))
            local STUCK_NEW=$(tail -n "$NEW_LINES" "$STDERR_LOG" | grep -c 'ws-stuck')
            if [ "$STUCK_NEW" -ge 2 ]; then
                if [ -f "$STDOUT_LOG" ]; then
                    local RECONNECT_NEW=$(tail -n 50 "$STDOUT_LOG" | grep -c '已重连')
                    if [ "$RECONNECT_NEW" -eq 0 ]; then
                        restart_bridge "新增日志显示连接卡住且未重连（${STUCK_NEW}次警告）"
                        return 0
                    fi
                fi
            fi
        fi
    fi
}

check_profile claude
check_profile antigravity
