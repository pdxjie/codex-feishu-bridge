#!/bin/zsh
set -euo pipefail

label="com.gaochenjie.codex-feishu-bridge"
project_dir="/Users/gaochenjie/Desktop/codex-feishu-bridge"
source_plist="$project_dir/ops/$label.plist"
installed_plist="/Users/gaochenjie/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
service="$domain/$label"

case "${1:-status}" in
  install)
    mkdir -p "$project_dir/data" "/Users/gaochenjie/Library/LaunchAgents"
    plutil -lint "$source_plist"
    launchctl bootout "$service" >/dev/null 2>&1 || true
    cp "$source_plist" "$installed_plist"
    launchctl bootstrap "$domain" "$installed_plist"
    launchctl enable "$service"
    launchctl kickstart -k "$service"
    echo "已安装并启动 $label"
    ;;
  restart)
    launchctl kickstart -k "$service"
    echo "已重启 $label"
    ;;
  stop)
    launchctl bootout "$service"
    echo "已停止 $label（plist 仍保留，可再次 install）"
    ;;
  status)
    launchctl print "$service"
    ;;
  logs)
    tail -n 100 "$project_dir/data/bridge.out.log" "$project_dir/data/bridge.err.log"
    ;;
  *)
    echo "用法：$0 {install|restart|stop|status|logs}" >&2
    exit 2
    ;;
esac
