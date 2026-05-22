# UNO

实时多人 UNO 纸牌游戏，基于 WebSocket，支持 AI、观战、加牌链。

## 技术栈

| 组件 | 协议 |
|------|------|
| TypeScript | Apache-2.0 |
| ws (WebSocket) | MIT |
| pkg | MIT |
| Blobmoji SVG | MIT |
| Vitest | MIT |
| Playwright | Apache-2.0 |
| tsx | MIT |

## 快速开始

```bash
pnpm install
pnpm build
pnpm start        # http://localhost:3000
```

## 构建可执行文件

```bash
./build.sh win    # Windows
./build.sh linux  # Linux
```

输出到 `release/`。

## 开发

```bash
pnpm dev          # tsx watch，即时重载
pnpm test         # 运行全部测试
```

## 项目结构

```
src/
  server.ts       # WebSocket 服务端 + 游戏逻辑
  client.ts       # 浏览器端 UI
  aiplayer.ts     # AI 决策
  errors.ts       # 错误定义
  constants.ts    # 常量
public/
  index.html      # 主页面
  style.css       # 样式
  icons/          # Blobmoji SVG 图标
test/
  server.test.js  # 服务端测试
  client.test.js  # 浏览器端测试
```

## 许可证

[BSD 3-Clause License](./LICENSE) · Copyright (c) 2026 miruku (lovemilk)
