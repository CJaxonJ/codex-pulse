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
echo "安装流程已结束。若你刚才选择了‘稍后’，请重新运行安装程序完成 Hook 信任。"
echo ""
read -r "?按回车键关闭窗口。"
