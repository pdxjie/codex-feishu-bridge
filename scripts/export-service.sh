#!/bin/zsh
set -euo pipefail
label="com.gaochenjie.codex-erp-export"
project_dir="${0:A:h:h}"
service="gui/$(id -u)/$label"
installed_plist="$HOME/Library/LaunchAgents/$label.plist"
case "${1:-status}" in
  install)
    plutil -lint "$project_dir/ops/$label.plist"
    if launchctl print "$service" >/dev/null 2>&1; then
      echo "服务已安装，请在导出任务结束后使用 restart。"
      exit 0
    fi
    cp "$project_dir/ops/$label.plist" "$installed_plist"
    launchctl bootstrap "gui/$(id -u)" "$installed_plist"
    launchctl enable "$service"
    ;;
  status) launchctl print "$service" ;;
  restart) launchctl kickstart -k "$service" ;;
  stop) launchctl bootout "$service" ;;
  *) echo "用法：$0 {install|status|restart|stop}" >&2; exit 2 ;;
esac
