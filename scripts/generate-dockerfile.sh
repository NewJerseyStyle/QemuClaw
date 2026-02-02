#!/bin/bash

###############################################################################
# 为 OpenClaw VM 构建自定义 Docker 镜像
#
# 参数:
#   $1: variant (gui 或 headless)
#   $2: output Dockerfile 路径
#
###############################################################################

set -e

VARIANT="${1:-gui}"
OUTPUT_FILE="${2:-Dockerfile.custom}"

echo "Building Dockerfile for $VARIANT variant..."

if [ "$VARIANT" = "gui" ]; then
    cat > "$OUTPUT_FILE" << 'EOF'
FROM openclaw:latest

USER root

# 安装 GUI 环境
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv systemd-container \
      linux-image-amd64 \
      grub-pc grub-common \
      grub-efi-amd64 \
      xorg x11-apps \
      xfce4 xfce4-terminal \
      lightdm lightdm-gtk-greeter \
      dbus-x11 \
      firefox-esr \
      fonts-noto-cjk \
      fonts-noto-cjk-extra && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# 配置 lightdm
RUN systemctl enable lightdm 2>/dev/null || true

# 创建启动脚本
RUN mkdir -p /usr/local/bin && \
    echo '#!/bin/bash' > /usr/local/bin/start-openclaw && \
    echo 'cd /app && node dist/index.js gateway --bind lan' >> /usr/local/bin/start-openclaw && \
    chmod +x /usr/local/bin/start-openclaw

USER node
CMD ["/sbin/init"]
EOF
else
    # Headless 版本
    cat > "$OUTPUT_FILE" << 'EOF'
FROM openclaw:latest

USER root

# 安装最小化系统包
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv \
      linux-image-amd64 \
      grub-pc grub-common \
      grub-efi-amd64 \
      nginx \
      curl \
      wget && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# 配置 Nginx
RUN rm -f /etc/nginx/sites-enabled/default && \
    echo 'server {' > /etc/nginx/sites-available/openclaw && \
    echo '  listen 3000 default_server;' >> /etc/nginx/sites-available/openclaw && \
    echo '  listen [::]:3000 default_server;' >> /etc/nginx/sites-available/openclaw && \
    echo '  server_name _;' >> /etc/nginx/sites-available/openclaw && \
    echo '  location / {' >> /etc/nginx/sites-available/openclaw && \
    echo '    proxy_pass http://localhost:18789;' >> /etc/nginx/sites-available/openclaw && \
    echo '    proxy_http_version 1.1;' >> /etc/nginx/sites-available/openclaw && \
    echo '    proxy_set_header Upgrade $http_upgrade;' >> /etc/nginx/sites-available/openclaw && \
    echo '    proxy_set_header Connection "upgrade";' >> /etc/nginx/sites-available/openclaw && \
    echo '    proxy_set_header Host $host;' >> /etc/nginx/sites-available/openclaw && \
    echo '  }' >> /etc/nginx/sites-available/openclaw && \
    echo '}' >> /etc/nginx/sites-available/openclaw && \
    ln -s /etc/nginx/sites-available/openclaw /etc/nginx/sites-enabled/openclaw

# 配置 systemd 服务
RUN echo '[Unit]' > /etc/systemd/system/openclaw.service && \
    echo 'Description=OpenClaw Gateway' >> /etc/systemd/system/openclaw.service && \
    echo 'After=network.target' >> /etc/systemd/system/openclaw.service && \
    echo '' >> /etc/systemd/system/openclaw.service && \
    echo '[Service]' >> /etc/systemd/system/openclaw.service && \
    echo 'Type=simple' >> /etc/systemd/system/openclaw.service && \
    echo 'User=node' >> /etc/systemd/system/openclaw.service && \
    echo 'WorkingDirectory=/app' >> /etc/systemd/system/openclaw.service && \
    echo 'ExecStart=/usr/bin/node dist/index.js gateway --bind lan' >> /etc/systemd/system/openclaw.service && \
    echo 'Restart=always' >> /etc/systemd/system/openclaw.service && \
    echo 'RestartSec=10' >> /etc/systemd/system/openclaw.service && \
    echo '' >> /etc/systemd/system/openclaw.service && \
    echo '[Install]' >> /etc/systemd/system/openclaw.service && \
    echo 'WantedBy=multi-user.target' >> /etc/systemd/system/openclaw.service && \
    systemctl enable openclaw.service 2>/dev/null || true && \
    systemctl enable nginx.service 2>/dev/null || true

USER node
CMD ["/sbin/init"]
EOF
fi

echo "Dockerfile generated: $OUTPUT_FILE"
