# Token 记录 · Desktop Token & Cost Monitor

一个悬浮在桌面上的实时用量看板，记录 **Claude Code**、**Codex**、**Grok Build** 三个 AI 编码工具的 **token 消耗**与**金钱花费**，数值变化带有精心设计的动效。

![成品预览](docs/preview.png)

折叠态（点标题栏「▁」收起为紧凑条，只看总 tokens 与总花费）：

![折叠态](docs/preview-compact.png)

## 特性

- **三源自动采集**：无需任何手工录入，直接读取三个工具在本机的会话记录。
  - Claude Code：`~/.claude/projects/*/*.jsonl` 的 `message.usage`
  - Codex：`~/.codex/sessions/**/*.jsonl` 的 `token_count` 事件
  - Grok Build：`~/.grok/sessions/**/updates.jsonl` 的 `turn_completed.usage`
- **精确计价**：区分输入 / 输出 / 缓存写 / 缓存读四类单价，按模型分别计费；自定义/代理模型标注“估算”。
- **实时增量刷新**：每 2 秒扫描一次，仅重解析发生变化的会话文件（按 mtime+size 判定），开销极低。
- **桌面悬浮窗**：无边框、半透明玻璃拟态、置顶、可拖动，停靠屏幕右上角。
- **可折叠 / 单实例**：一键折叠为仅显示总览的紧凑条；单实例运行，重复启动只聚焦已有窗口而非多开。
- **数值变化设计 + 收银音效**（见下）。

## 数值变化的设计

用户能一眼看到“数字在动”，而不是冷冰冰地跳变：

| 动效 | 触发时机 | 实现 |
|------|---------|------|
| **数字滚动** | 每次数值更新 | `requestAnimationFrame` + easeOutExpo 缓动，从旧值平滑滚到新值 |
| **增量气泡** | 某工具 token 增加时 | `+1.2K` 从卡片上浮并淡出 |
| **卡片脉冲** | 某工具 token 增加时 | 品牌色描边发光脉冲一次 |
| **进度条** | 每次刷新 | 该工具 token 占总量比例，宽度带缓动过渡 |
| **呼吸状态点** | 常驻 | 绿色圆点呼吸，表示实时在线 |
| **收银音效** | 某工具 token 增加时 | Web Audio 合成「叮-叮」收银声，标题栏 🔊 可开关（记忆偏好） |

数字使用等宽数字（`tabular-nums`），滚动时不会左右抖动。

## 运行

```bash
npm install        # 安装依赖（Electron）
npm start          # 启动桌面悬浮窗
npm run cli        # 不开窗，直接在终端打印一次聚合结果（快速核对数据）
npm test           # 运行单元测试
```

> 若 Electron 二进制下载失败（国内网络常见），已在安装说明中提供镜像方案，见 `.claude/operations-log.md`。

## 桌面快捷方式（免安装绿色启动）

在桌面生成一个「Token 记录」图标，双击即弹出悬浮窗：

```bash
npm run icon       # 生成品牌图标 build/icon.ico（首次需要）
npm run shortcut   # 在桌面创建「Token 记录」快捷方式
```

也可直接双击项目根目录的 `launch.cmd`。

**为何不是独立 exe？** 复制 / 重命名 Electron 二进制（约 190MB 未签名文件）会被 Windows Defender 实时防护隔离。因此采用绿色启动：快捷方式直接驱动项目内已就绪、被系统信任的 Electron 运行时加载本应用，稳定可靠。代价是快捷方式硬编码了项目路径——**请勿移动项目目录**，移动后重新执行 `npm run shortcut` 即可。

## 架构

关注点分离，数据层与 UI 层解耦（数据层可脱离 Electron 独立运行与验证）：

```
src/
├── shared/          # 通用工具：路径解析、JSONL 流式读取、文件遍历
├── collectors/      # 三源采集器：claude.js / codex.js / grok.js
├── pricing/         # 定价表 pricing.json + 计算器 calculator.js
├── core/            # aggregator.js 聚合去重计价 + store.js 增量缓存与快照
├── cli.js           # 终端校验入口
├── main/            # Electron 主进程 main.js + preload.js
└── renderer/        # UI：index.html / style.css / animations.js / app.js
```

## 定价说明

定价表位于 `src/pricing/pricing.json`，单位为**美元 / 每百万 token**，基于各厂商公开定价整理。
- `grok-4.5-build-free` 为免费档，计费为 0。
- `gpt-5.6-terra`（经本地代理的自定义模型）等无公开价者按同级模型**估算**，界面与报表均标注“含估算定价”。
- 如与你的实际账单不符，直接修改该文件即可，无需改代码。

## 数据只读

本工具只**读取**上述会话文件，从不修改或上传任何数据，全部计算在本地完成。
