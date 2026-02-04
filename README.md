# QemuClaw

[![Build OpenClaw VM (Optimized)](https://github.com/NewJerseyStyle/QemuClaw/actions/workflows/build.yml/badge.svg)](https://github.com/NewJerseyStyle/QemuClaw/actions/workflows/build.yml)

Deploy OpenClaw in one click using Qemu VM on any machine

## Quick start
Download released Qemu VM image, start it with Qemu
1. Install QEMU using [instruction on official website by selecting your system](https://www.qemu.org/download/#macos)
2. Download all Qemu VM image files end with `.qcow2` or `.tar.gz.aa` from [our release page](https://github.com/NewJerseyStyle/QemuClaw/releases)
3. Unzip/Untar the image if it ends with `gz.aa`, `gz.ab` ... by extract selecting the `.aa` one
4. Start the VM `./qemu-system-x86_64 -m 2G -drive file=./openclaw-headless-compressed.qcow2,format=qcow2`
5. Login with username `node` and password `openclaw`
6. Run `cd /app; node dist/index.js onboard`

> 🏗️ We will provide tool to manage all the steps for you soon.
