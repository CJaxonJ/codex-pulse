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

node scripts/install-macos.mjs

echo ""
echo "安装完成。请完全退出并重新打开 Codex，然后输入 /hooks 检查并信任 Codex Pulse。"
echo ""
read -r "?按回车键关闭窗口。"
