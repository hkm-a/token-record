<p align="center">
  <img src="docs/readme/hero.svg" width="100%" alt="Token 记录：在桌面悬浮窗中汇总 Claude Code、Codex 与 Grok Build 的本地 token 用量和费用。">
</p>

# Token 记录

> 实时查看 Claude Code、Codex 和 Grok Build 的 token 消耗与估算费用，无需手工记账。

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#它解决什么问题">工作方式</a> ·
  <a href="#验证">验证</a>
</p>

![Token 记录主界面，展示三种工具的 token 用量和费用汇总](docs/preview.png)

折叠后仅保留总 token 与总费用，适合常驻桌面：

![Token 记录折叠态](docs/preview-compact.png)

## 它解决什么问题

AI 编码工具的用量分散在各自的本地会话记录中，难以横向比较。Token 记录读取 Claude Code、Codex 与 Grok Build 的本地会话文件，按模型价格汇总 token 与费用，并以可折叠的桌面悬浮窗展示结果。

## 功能

- **三源自动汇总**：读取三个工具的本地会话记录，不需要手工录入。
- **分项计价**：区分输入、输出、缓存写入与缓存读取；无公开价格的自定义模型会标记为估算。
- **增量刷新**：每两秒扫描一次，仅重解析修改过的会话文件。
- **桌面悬浮窗**：支持置顶、拖动、折叠和单实例启动。
- **变化可见**：数值滚动、增量气泡和卡片脉冲让新消耗一眼可见；收银音效可在标题栏关闭。

## 快速开始

前提：已安装 Node.js，并允许 Electron 下载运行时。

```bash
npm install
npm start
```

启动后，桌面右上角会出现悬浮窗。运行 `npm run cli` 可在终端核对一次聚合结果。

## 它如何工作

```text
本地会话 JSONL
  -> 三个采集器读取各自格式
  -> 聚合、去重与按模型计价
  -> Electron 悬浮窗与 CLI 展示结果
```

| 数据源 | 读取位置 | 提取内容 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | `message.usage` |
| Codex | `~/.codex/sessions/**/*.jsonl` | `token_count` 事件 |
| Grok Build | `~/.grok/sessions/**/updates.jsonl` | `turn_completed.usage` |

工具仅读取这些文件，所有聚合和计价均在本地完成。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动桌面悬浮窗 |
| `npm run cli` | 在终端输出一次汇总 |
| `npm test` | 运行 Node.js 单元测试 |
| `npm run icon` | 生成桌面图标 |
| `npm run shortcut` | 创建桌面快捷方式 |

## 计价与限制

定价表位于 `src/pricing/pricing.json`，单位为美元/每百万 token。`grok-4.5-build-free` 按免费档计价；没有公开价格的自定义或代理模型会按匹配规则估算，并在界面与报表中标记。

当前快捷方式方案直接使用项目内的 Electron 运行时，因此移动项目目录后，需要重新执行 `npm run shortcut`。

## 验证

```bash
npm test
npm run cli
```

测试覆盖采集器、聚合去重和计价器；CLI 可用于与实际会话记录交叉核对。
