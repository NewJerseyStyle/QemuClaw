#!/bin/bash

###############################################################################
# 设置 GitHub Actions 运行环境
#
###############################################################################

set -e

echo "Setting up GitHub Actions environment..."

# 安装必要的工具
echo "[1/3] Installing dependencies..."
sudo apt-get update
sudo apt-get install -y \
  qemu-utils \
  qemu-system-x86-64 \
  e2fsprogs \
  parted \
  grub-pc-bin \
  p7zip-full \
  pv \
  jq

echo "✓ Dependencies installed"

# 检查 Docker
echo "[2/3] Checking Docker..."
if ! command -v docker &> /dev/null; then
  echo "Error: Docker is not installed"
  exit 1
fi
docker --version

# 设置 Docker Buildx（用于更高效的镜像构建）
echo "[3/3] Setting up Docker Buildx..."
docker buildx create --use || true
docker buildx inspect --bootstrap || true

echo "✓ Environment setup completed"
