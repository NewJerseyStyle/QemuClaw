#!/bin/bash

###############################################################################
# 将 Docker 镜像导出并安装到 QEMU VM 磁盘
#
# 参数:
#   $1: variant (gui 或 headless)
#   $2: qcow2 文件路径
#
###############################################################################

set -e

VARIANT="${1:-gui}"
QCOW2_FILE="${2:-openclaw-${VARIANT}.qcow2}"

echo "Installing system to VM disk..."
echo "Variant: $VARIANT"
echo "Disk: $QCOW2_FILE"

# 导出 Docker 镜像到 rootfs
echo "[1/5] Exporting Docker image to rootfs..."
CONTAINER_ID=$(docker create openclaw-${VARIANT}:latest)
echo "Container ID: $CONTAINER_ID"

docker export $CONTAINER_ID > rootfs.tar
docker rm $CONTAINER_ID

echo "✓ Rootfs exported: $(du -h rootfs.tar | cut -f1)"

# 加载 NBD 模块
echo "[2/5] Loading NBD module..."
sudo modprobe nbd max_part=8

# 连接 qcow2 到 NBD
echo "[3/5] Connecting disk to NBD..."
sudo qemu-nbd --connect=/dev/nbd0 "$QCOW2_FILE"
sleep 2

# 分区和格式化
echo "[4/5] Partitioning and formatting..."
sudo parted /dev/nbd0 --script mklabel msdos
sudo parted /dev/nbd0 --script mkpart primary ext4 1MiB 100%
sudo partprobe /dev/nbd0
sleep 2

sudo mkfs.ext4 -F /dev/nbd0p1

# 掛載並解壓
echo "[5/5] Mounting and extracting rootfs..."
sudo mkdir -p /mnt/vm
sudo mount /dev/nbd0p1 /mnt/vm

echo "Extracting rootfs (this may take a while)..."
sudo tar -xf rootfs.tar -C /mnt/vm

# 配置 fstab
echo "Configuring fstab..."
echo '/dev/sda1 / ext4 defaults,errors=remount-ro 0 1' | sudo tee /mnt/vm/etc/fstab

# 安装 bootloader
echo "Installing bootloader..."
sudo mount --bind /dev /mnt/vm/dev
sudo mount --bind /proc /mnt/vm/proc
sudo mount --bind /sys /mnt/vm/sys
sudo mount --bind /boot /mnt/vm/boot || true

sudo chroot /mnt/vm /bin/bash -c "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  
  # 安装 grub
  apt-get update
  apt-get install -y --no-install-recommends grub-pc grub-efi-amd64 || true
  
  # 配置 grub
  grub-install --target=i386-pc /dev/nbd0 || true
  update-grub || true
" || echo "Bootloader installation completed with warnings"

# 清理
echo "Cleaning up..."
sudo umount /mnt/vm/boot 2>/dev/null || true
sudo umount /mnt/vm/dev /mnt/vm/proc /mnt/vm/sys
sudo umount /mnt/vm
sudo qemu-nbd --disconnect /dev/nbd0

# 删除 rootfs
rm -f rootfs.tar

echo "✓ VM installation completed"
