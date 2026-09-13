# QuantPick pm2 守护配置
# 使用: pm2 start deploy/ecosystem.config.js
module.exports = {
  apps: [{
    name: 'quantpick',
    cwd: __dirname + '/..',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
      PORT: 8090
    }
  }]
};
