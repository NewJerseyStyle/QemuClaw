#!/bin/bash

###############################################################################
# 压缩 VM 磁盘并分割成多个部分
#
# 参数:
#   $1: variant (gui 或 headless)
#   $2: 输出目录
#   $3: 部分大小 (默认 1500m)
#
###############################################################################

set -e

VARIANT="${1:-gui}"
OUTPUT_DIR="${2:-.}"
PART_SIZE="${3:-1500m}"

DISK_FILE="openclaw-${VARIANT}.qcow2"
COMPRESSED_FILE="openclaw-${VARIANT}-compressed.qcow2"

echo "Compressing and splitting VM disk..."
echo "Variant: $VARIANT"
echo "Output directory: $OUTPUT_DIR"
echo "Part size: $PART_SIZE"

mkdir -p "$OUTPUT_DIR"

# 压缩 VM 磁盘
echo "[1/3] Compressing VM disk with QEMU..."
qemu-img convert -c -O qcow2 \
  "$DISK_FILE" \
  "$COMPRESSED_FILE"

COMPRESSED_SIZE=$(du -h "$COMPRESSED_FILE" | cut -f1)
echo "✓ Compression completed: $COMPRESSED_SIZE"

# 分割文件
echo "[2/3] Splitting into parts..."
tar czf - "$COMPRESSED_FILE" | split -b "$PART_SIZE" - "$OUTPUT_DIR/openclaw-${VARIANT}.tar.gz."

echo "✓ Split completed"
ls -lh "$OUTPUT_DIR/openclaw-${VARIANT}.tar.gz."* 

# 生成校验和
echo "[3/3] Generating checksums..."
cd "$OUTPUT_DIR"
sha256sum openclaw-${VARIANT}.tar.gz.* > openclaw-${VARIANT}.sha256
cd - > /dev/null

echo "✓ Checksums generated"

# 显示统计信息
echo ""
echo "=== Summary ==="
TOTAL_SIZE=$(du -sh "$OUTPUT_DIR" | cut -f1)
echo "Total size: $TOTAL_SIZE"
echo "Files:"
ls -lh "$OUTPUT_DIR/openclaw-${VARIANT}.tar.gz."* | awk '{print "  " $9 " (" $5 ")"}'
echo "Checksum: $OUTPUT_DIR/openclaw-${VARIANT}.sha256"
