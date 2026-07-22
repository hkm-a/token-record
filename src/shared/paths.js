'use strict';

// 数据源路径解析：集中管理三个 CLI 工具在本机的会话数据根目录。
// 设计意图：将“数据在哪里”与“如何解析”解耦，便于测试时注入自定义目录，
// 也便于未来某个工具改变存储位置时只改这一处。

const os = require('os');
const path = require('path');

// 用户主目录。三个工具均把数据写在主目录下的隐藏目录中。
const HOME = os.homedir();

// 各数据源根目录。允许通过环境变量覆盖，方便测试与非默认安装位置。
const SOURCE_ROOTS = {
  // Claude Code：每个项目一个子目录，内含若干 <sessionId>.jsonl 会话文件。
  claude: process.env.TOKENREC_CLAUDE_DIR || path.join(HOME, '.claude', 'projects'),
  // Codex：sessions/年/月/日/rollout-*.jsonl。
  codex: process.env.TOKENREC_CODEX_DIR || path.join(HOME, '.codex', 'sessions'),
  // Grok Build：sessions/<编码后的cwd>/<sessionId>/updates.jsonl。
  grok: process.env.TOKENREC_GROK_DIR || path.join(HOME, '.grok', 'sessions'),
};

// 返回指定数据源的根目录绝对路径。
function rootOf(source) {
  const root = SOURCE_ROOTS[source];
  if (!root) {
    throw new Error(`未知数据源：${source}`);
  }
  return root;
}

module.exports = { HOME, SOURCE_ROOTS, rootOf };
