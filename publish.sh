#!/usr/bin/env bash
#
# dsh-memory-agent 一条命令发布。
#
#   bash publish.sh
#
# 顺序：
#   1. 优先把整段发布委托给 dsh-publish-plugin（DSH 官方的发插件工具）；
#   2. 它不可用时，本脚本自己跑完整流程：verify.sh → pack 预检 → 认证闸门 → npm publish。
#
# 退出码：0 成功；1 校验/发布失败；3 缺少 npm 认证（不是发布成功，别误读）。
set -euo pipefail
cd "$(dirname "$0")"

PKG_NAME="$(node -e "process.stdout.write(require('./package.json').name)")"
PKG_VERSION="$(node -e "process.stdout.write(require('./package.json').version)")"

echo "== 发布 $PKG_NAME@$PKG_VERSION =="

# ---------- 1. 首选 dsh-publish-plugin ----------
if command -v dsh-publish-plugin >/dev/null 2>&1; then
  echo "检测到 dsh-publish-plugin，整段委托给它"
  exec dsh-publish-plugin publish
fi
if npx --no-install dsh-publish-plugin --version >/dev/null 2>&1; then
  echo "通过 npx 找到 dsh-publish-plugin，整段委托给它"
  exec npx --no-install dsh-publish-plugin publish
fi
echo "dsh-publish-plugin 不可用 → 走 publish.sh 的整体流程"

# ---------- 2. 校验（唯一门槛：verify.sh 退出码 0） ----------
echo ""
echo "-- 校验 --"
bash ./verify.sh

# ---------- 3. 打包预检 ----------
echo ""
echo "-- 打包预检 --"
npm pack --dry-run >/dev/null
echo "pack 清单 OK"

# ---------- 4. 认证闸门 ----------
echo ""
echo "-- 认证闸门 --"
if [ -n "${NPM_TOKEN:-}" ]; then
  echo "使用 NPM_TOKEN"
  export NODE_AUTH_TOKEN="$NPM_TOKEN"
  # 用 token 写一份临时 .npmrc，避免依赖用户全局登录态
  printf 'registry=%s\n//registry.npmjs.org/:_authToken=%s\n' \
    "${NPM_REGISTRY:-https://registry.npmjs.org/}" "$NPM_TOKEN" > .npmrc.publish
  trap 'rm -f .npmrc.publish' EXIT
  NPMRC_FLAG="--userconfig=./.npmrc.publish"
else
  if npm whoami >/dev/null 2>&1; then
    echo "已登录 npm：$(npm whoami)"
    NPMRC_FLAG=""
  else
    cat <<'MSG'
ERROR: 没有 npm 认证，拒绝假装发布。

任选一种方式：
  1) npm login                       # 交互式登录
  2) export NPM_TOKEN=npm_xxx        # CI 里用 granular token
  3) export NPM_REGISTRY=https://registry.npmmirror.com   # 发到镜像源

然后重跑：bash publish.sh
MSG
    exit 3
  fi
fi

# ---------- 5. 发布 ----------
echo ""
echo "-- npm publish --"
# prepublishOnly 会自动重新 build + 跑一遍 fixture
if [ -n "$NPMRC_FLAG" ]; then
  npm publish --access public $NPMRC_FLAG
else
  npm publish --access public
fi

echo ""
echo "发布完成：$PKG_NAME@$PKG_VERSION"
