#!/bin/bash

###############################################################################
# 清理 VM 构建过程中的临时文件
#
# 参数:
#   $1: variant (gui 或 headless)
#
###############################################################################

set -e

VARIANT="${1:-gui}"

echo "Cleaning up temporary files..."

# 删除临时文件
rm -f rootfs.tar
rm -f openclaw-${VARIANT}.qcow2
rm -f openclaw-${VARIANT}-compressed.qcow2
rm -f Dockerfile.custom
rm -rf dist
rm -rf recovered

# 清理 Docker
echo "Cleaning Docker system..."
docker system prune -af 2>/dev/null || true

echo "✓ Cleanup completed"
