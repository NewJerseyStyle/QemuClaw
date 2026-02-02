#!/bin/bash

###############################################################################
# 生成恢复脚本和相关文档
#
# 参数:
#   $1: variant (gui 或 headless)
#   $2: 输出目录
#
###############################################################################

set -e

VARIANT="${1:-gui}"
OUTPUT_DIR="${2:-.}"

echo "Generating recovery script and documentation..."

cd "$OUTPUT_DIR"

# 生成恢复脚本
cat > "openclaw-${VARIANT}-recover.sh" << 'EOF'
#!/bin/bash
set -e

VARIANT="{{ VARIANT }}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=========================================="
echo "OpenClaw VM Recovery Tool"
echo "=========================================="
echo "Variant: $VARIANT"
echo ""

# 检查文件
PART_COUNT=$(ls -1 openclaw-${VARIANT}.tar.gz.* 2>/dev/null | wc -l)
if [ $PART_COUNT -eq 0 ]; then
  echo "Error: No split files found"
  exit 1
fi

echo "Found $PART_COUNT split files"
echo ""

# 验证
if [ -f openclaw-${VARIANT}.sha256 ]; then
  echo "Verifying checksums..."
  if ! sha256sum -c openclaw-${VARIANT}.sha256; then
    echo "Error: Verification failed!"
    exit 1
  fi
  echo "✓ All files verified"
else
  echo "Warning: Checksum file not found, skipping verification"
fi

echo ""
echo "Extracting files (this may take a while)..."

# 合并和解压
if command -v pv &> /dev/null; then
  cat openclaw-${VARIANT}.tar.gz.* | \
    pv -N "Extracting" | \
    tar xzf -
else
  cat openclaw-${VARIANT}.tar.gz.* | tar xzf -
fi

echo ""
if [ -f openclaw-${VARIANT}-compressed.qcow2 ]; then
  echo "✓ Recovery completed successfully!"
  echo ""
  ls -lh openclaw-${VARIANT}-compressed.qcow2
  echo ""
  echo "Next steps:"
  echo "  qemu-system-x86_64 -drive file=openclaw-${VARIANT}-compressed.qcow2,format=qcow2 -m 4G"
else
  echo "Error: Output file not found"
  exit 1
fi
EOF

# 替换变量
sed -i "s|{{ VARIANT }}|$VARIANT|g" "openclaw-${VARIANT}-recover.sh"
chmod +x "openclaw-${VARIANT}-recover.sh"

echo "✓ Recovery script generated: openclaw-${VARIANT}-recover.sh"

# 生成清单文件
cat > "openclaw-${VARIANT}.manifest" << EOF
# OpenClaw VM - ${VARIANT^^} Edition 镜像清单
# Generated at: $(date -u +'%Y-%m-%d %H:%M:%S UTC')
# 
# File list:
EOF

ls -lh openclaw-${VARIANT}.tar.gz.* >> "openclaw-${VARIANT}.manifest" 2>/dev/null || true

echo "✓ Manifest generated: openclaw-${VARIANT}.manifest"

# 生成 README
cat > "README-${VARIANT}.md" << 'EOF'
# OpenClaw VM - {{ VARIANT_UPPER }} Edition

This VM image has been splitted to multiple 1.5GB files for download and transfer.

## Merge

### Linux/macOS

```bash
# Enter where downloaded the files
cd ~/Downloads/openclaw

# Merge
bash openclaw-{{ VARIANT }}-recover.sh
```

### Windows (PowerShell)

```powershell
# Using WSL
wsl bash openclaw-{{ VARIANT }}-recover.sh

# Using Git Bash
bash openclaw-{{ VARIANT }}-recover.sh
```

## Verify the file

```bash
sha256sum -c openclaw-{{ VARIANT }}.sha256
```

## Start the VM

```bash
qemu-system-x86_64 \
  -drive file=openclaw-{{ VARIANT }}-compressed.qcow2,format=qcow2 \
  -m 4G \
  -cpu host \
  -smp cores=2
```

## Convert to other format

- **VirtualBox**: `qemu-img convert -f qcow2 -O vdi openclaw-{{ VARIANT }}-compressed.qcow2 openclaw-{{ VARIANT }}.vdi`
- **Hyper-V**: `qemu-img convert -f qcow2 -O vhdx openclaw-{{ VARIANT }}-compressed.qcow2 openclaw-{{ VARIANT }}.vhdx`
- **VMware**: `qemu-img convert -f qcow2 -O vmdk openclaw-{{ VARIANT }}-compressed.qcow2 openclaw-{{ VARIANT }}.vmdk`
EOF

# 替换变量
sed -i "s|{{ VARIANT }}|$VARIANT|g" "README-${VARIANT}.md"
sed -i "s|{{ VARIANT_UPPER }}|${VARIANT^^}|g" "README-${VARIANT}.md"

echo "✓ README generated: README-${VARIANT}.md"

cd - > /dev/null

echo ""
echo "=== Generation Complete ==="
echo "Files generated in $OUTPUT_DIR:"
ls -lh "$OUTPUT_DIR"/openclaw-${VARIANT}-recover.sh \
          "$OUTPUT_DIR"/openclaw-${VARIANT}.manifest \
          "$OUTPUT_DIR"/README-${VARIANT}.md 2>/dev/null || true
