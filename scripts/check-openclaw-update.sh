#!/bin/bash

###############################################################################
# 检查 OpenClaw Docker 镜像是否有更新
# 
# 输出:
#   should_build=true/false
#   image_digest=<digest>
#   timestamp=<timestamp>
#
###############################################################################

set -e

echo "Checking for OpenClaw Docker image updates..."

# 获取最新的镜像摘要
LATEST_DIGEST=$(docker manifest inspect ghcr.io/phioranex/openclaw-docker:latest 2>/dev/null | \
  jq -r '.config.digest' || echo "unknown")

echo "Latest digest: $LATEST_DIGEST"
echo "digest=$LATEST_DIGEST" >> $GITHUB_OUTPUT

# 检查是否已经为这个版本构建过
RELEASE_TAG="vm-${LATEST_DIGEST:7:12}"

if gh release view "$RELEASE_TAG" &>/dev/null 2>&1; then
  echo "Already built for this version"
  echo "should_build=false" >> $GITHUB_OUTPUT
else
  echo "New version detected"
  echo "should_build=true" >> $GITHUB_OUTPUT
fi

# 记录时间戳
echo "timestamp=$(date -u +'%Y-%m-%d %H:%M:%S UTC')" >> $GITHUB_OUTPUT

echo "Check completed"
