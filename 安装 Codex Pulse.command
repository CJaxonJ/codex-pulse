#!/bin/zsh
set -e

cd -- "$(dirname -- "$0")"

echo ""
echo "Codex Pulse 测试版安装"
echo "======================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js。请先安装 Node.js 20 或更高版本，再重新双击此文件。"
  echo "https://nodejs.org/"
  echo ""
  read -r "?按回车键关闭窗口。"
  exit 1
fi

CODEX_PULSE_INTERACTIVE_INSTALL=1 node scripts/install-macos.mjs

echo ""
echo "安装流程已结束。若选择了‘稍后开启’，可打开 Codex Pulse → 保护授权继续，不需要重装。"
echo ""
read -r "?按回车键关闭窗口。"
