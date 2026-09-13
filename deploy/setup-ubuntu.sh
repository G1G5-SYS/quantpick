#!/usr/bin/env bash
# ============================================================================
# QuantPick 一键部署(Ubuntu 22.04 / 24.04,需要 root 或 sudo)
# 用法:
#   sudo bash deploy/setup-ubuntu.sh                 # 默认端口 8090,无域名(本机/内网)
#   sudo DOMAIN=your-domain.com bash deploy/setup-ubuntu.sh   # 绑定域名(nginx server_name)
# 部署后:
#   应用  http://服务器IP:8090/       官网  http://服务器IP:8090/website/
#   域名  http://your-domain.com/      HTTPS: sudo certbot --nginx -d your-domain.com
# ============================================================================
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8090}"
DOMAIN="${DOMAIN:-}"

echo "==> 0/6 环境"
echo "    项目目录: $APP_DIR"
echo "    监听端口: $PORT  域名: ${DOMAIN:-<未绑定>}"

echo "==> 1/6 安装 Node.js 18(如未安装)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> 2/6 安装 pm2(如未安装)"
if ! command -v pm2 >/dev/null 2>&1; then npm i -g pm2; fi
pm2 --version

echo "==> 3/6 安装 nginx(如未安装)"
if ! command -v nginx >/dev/null 2>&1; then apt-get install -y nginx; fi
nginx -v 2>&1 || true

echo "==> 4/6 启动应用(pm2 守护,端口 $PORT)"
cd "$APP_DIR"
PORT="$PORT" pm2 start server.js --name quantpick
pm2 save
pm2 startup 2>/dev/null || echo "(pm2 startup 需手动执行其输出命令以开启开机自启)"

echo "==> 5/6 配置 Nginx 反代"
cp deploy/nginx-quantpick.conf /etc/nginx/conf.d/quantpick.conf
sed -i "s|proxy_pass http://127.0.0.1:8090;|proxy_pass http://127.0.0.1:${PORT};|g" /etc/nginx/conf.d/quantpick.conf
if [ -n "$DOMAIN" ]; then sed -i "s/your-domain.com/$DOMAIN/g" /etc/nginx/conf.d/quantpick.conf; fi
nginx -t && systemctl reload nginx

echo "==> 6/6 部署自检"
node deploy/check.js "http://127.0.0.1:${PORT}"

echo ""
echo "============================================"
echo "  部署完成"
echo "  应用:  http://127.0.0.1:${PORT}/"
echo "  官网:  http://127.0.0.1:${PORT}/website/"
if [ -n "$DOMAIN" ]; then
  echo "  公网:  http://$DOMAIN/"
  echo "  HTTPS: sudo certbot --nginx -d $DOMAIN"
fi
echo "============================================"
