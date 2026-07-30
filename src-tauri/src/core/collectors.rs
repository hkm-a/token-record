use super::jsonl;
use super::types::TokenEvent;
use chrono::{Local, TimeZone, Utc};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// 单文件解析缓存条目：以 (mtime, size) 判定文件是否变化。
struct CacheEntry {
    mtime: SystemTime,
    size: u64,
    events: Vec<TokenEvent>,
}

/// 会话目录可达数百 MB，逐 tick 全量重解析不可接受；
/// 未变化的文件直接复用上次解析结果，仅重读 mtime/size 变化的文件。
/// 已删除文件的残留条目量级极小（仅解析结果），不做主动清理。
/// 注意：缺失时间戳的记录 day_key 按解析时刻落日，缓存期间跨天不会重算（此类记录极少）。
static PARSE_CACHE: LazyLock<Mutex<HashMap<PathBuf, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 带缓存的单文件解析：文件未变化时返回缓存副本，否则调用 parse 并回填缓存。
fn parse_file_cached(path: &Path, parse: fn(&Path) -> Vec<TokenEvent>) -> Vec<TokenEvent> {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let size = meta.len();

    {
        let cache = PARSE_CACHE.lock().unwrap();
        if let Some(entry) = cache.get(path) {
            if entry.mtime == mtime && entry.size == size {
                return entry.events.clone();
            }
        }
    }

    let events = parse(path);
    PARSE_CACHE.lock().unwrap().insert(
        path.to_path_buf(),
        CacheEntry {
            mtime,
            size,
            events: events.clone(),
        },
    );
    events
}

/// Home 目录辅助
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// 从时间戳（毫秒）生成本地日期键 YYYY-MM-DD
fn local_day_key(ts_ms: i64) -> String {
    if ts_ms <= 0 {
        return Local::now().format("%Y-%m-%d").to_string();
    }
    if let Some(dt) = Utc.timestamp_millis_opt(ts_ms).single() {
        let local = dt.with_timezone(&Local);
        return local.format("%Y-%m-%d").to_string();
    }
    Local::now().format("%Y-%m-%d").to_string()
}

/// 解析 ISO 8601 时间戳字符串为毫秒
fn parse_ts(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

/// 列出目录下所有匹配 .jsonl 的文件（非递归）
pub fn list_jsonl_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !dir.exists() {
        return files;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map_or(false, |e| e == "jsonl") && path.is_file() {
                files.push(path);
            }
        }
    }
    files
}

/// 列出目录下递归匹配的 .jsonl 文件
pub fn list_jsonl_files_recursive(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if !dir.exists() {
        return files;
    }
    collect_jsonl(dir, &mut files);
    files
}

fn collect_jsonl(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_jsonl(&path, files);
            } else if path.extension().map_or(false, |e| e == "jsonl") {
                files.push(path);
            }
        }
    }
}

// ═══════════════════════════════════════════════════════
// Claude Code 采集器
// 数据来源：~/.claude/projects/<项目>/<sessionId>.jsonl
// ═══════════════════════════════════════════════════════

pub fn collect_claude_events() -> Vec<TokenEvent> {
    let root = home_dir().join(".claude").join("projects");
    if !root.exists() {
        return Vec::new();
    }
    let mut events = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let proj_dir = entry.path();
            if proj_dir.is_dir() {
                for file in list_jsonl_files(&proj_dir) {
                    events.extend(parse_file_cached(&file, parse_claude_file));
                }
            }
        }
    }
    events
}

fn parse_claude_file(path: &Path) -> Vec<TokenEvent> {
    let lines = jsonl::read_jsonl(path);
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown");
    let mut events = Vec::new();

    for record in &lines {
        if record.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let msg = match record.get("message") {
            Some(m) => m,
            None => continue,
        };
        let usage = match msg.get("usage") {
            Some(u) => u,
            None => continue,
        };
        let model = match msg.get("model").and_then(|v| v.as_str()) {
            Some(m) if m != "<synthetic>" => m.to_string(),
            _ => continue,
        };

        let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_write = usage.get("cache_creation_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        if input == 0 && output == 0 && cache_write == 0 && cache_read == 0 {
            continue;
        }

        let ts = record.get("timestamp").and_then(|v| v.as_str()).map(parse_ts).unwrap_or(0);
        let msg_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let request_id = record.get("requestId").and_then(|v| v.as_str()).unwrap_or("");
        let dedupe_key = if !msg_id.is_empty() || !request_id.is_empty() {
            format!("claude:{}:{}", msg_id, request_id)
        } else {
            let uuid = record.get("uuid").and_then(|v| v.as_str()).unwrap_or("");
            format!("claude:{}:{}", file_stem, uuid)
        };
        let session_id = record
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or(file_stem)
            .to_string();

        let cost = super::pricing::calc_cost(input, output, cache_write, cache_read, &model);
        let estimated = !super::pricing::is_free(&super::pricing::match_model(&model));

        events.push(TokenEvent {
            tool: "claude".to_string(),
            model,
            model_label: String::new(),
            input,
            output,
            cache_write,
            cache_read,
            cost,
            estimated,
            day_key: local_day_key(ts),
            dedupe_key,
            session_id,
            timestamp: ts,
        });
    }
    events
}

// ═══════════════════════════════════════════════════════
// Codex 采集器
// 数据来源：~/.codex/sessions/**/*.jsonl
// ═══════════════════════════════════════════════════════

pub fn collect_codex_events() -> Vec<TokenEvent> {
    let root = home_dir().join(".codex").join("sessions");
    if !root.exists() {
        return Vec::new();
    }
    let files = list_jsonl_files_recursive(&root);
    let mut events = Vec::new();
    for file in &files {
        events.extend(parse_file_cached(file, parse_codex_file));
    }
    events
}

/// Codex 的 token_count 事件可能因会话重放重复写入。只有 last 与 total
/// 全字段完全相同，才能确定这不是新的增量。
#[derive(Debug, Clone, Eq, Hash, PartialEq)]
struct CodexUsageSnapshot {
    last_input: u64,
    last_cached_input: u64,
    last_cache_write: u64,
    last_output: u64,
    last_reasoning: u64,
    last_total: u64,
    total_input: u64,
    total_cached_input: u64,
    total_cache_write: u64,
    total_output: u64,
    total_reasoning: u64,
    total_total: u64,
}

impl CodexUsageSnapshot {
    fn from_usage(last: &serde_json::Value, total: &serde_json::Value) -> Self {
        Self {
            last_input: usage_tokens(last, "input_tokens"),
            last_cached_input: cached_input_tokens(last),
            last_cache_write: usage_tokens(last, "cache_write_input_tokens"),
            last_output: usage_tokens(last, "output_tokens"),
            last_reasoning: usage_tokens(last, "reasoning_output_tokens"),
            last_total: usage_tokens(last, "total_tokens"),
            total_input: usage_tokens(total, "input_tokens"),
            total_cached_input: cached_input_tokens(total),
            total_cache_write: usage_tokens(total, "cache_write_input_tokens"),
            total_output: usage_tokens(total, "output_tokens"),
            total_reasoning: usage_tokens(total, "reasoning_output_tokens"),
            total_total: usage_tokens(total, "total_tokens"),
        }
    }
}

fn usage_tokens(usage: &serde_json::Value, field: &str) -> u64 {
    usage.get(field).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn cached_input_tokens(usage: &serde_json::Value) -> u64 {
    usage
        .get("cached_input_tokens")
        .or_else(|| usage.get("cache_read_input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

pub fn parse_codex_file(path: &Path) -> Vec<TokenEvent> {
    let lines = jsonl::read_jsonl(path);
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown");
    let mut events = Vec::new();

    let mut model: Option<String> = None;
    let mut session_id = file_stem.to_string();
    let mut last_ts: i64 = 0;

    // 按日累加 last_token_usage 增量
    let mut by_day: HashMap<String, CodexDayAcc> = HashMap::new();
    let mut saw_last = false;
    let mut last_total: Option<serde_json::Value> = None;
    let mut seen_snapshots: HashSet<CodexUsageSnapshot> = HashSet::new();

    struct CodexDayAcc {
        input: u64,
        cached_input: u64,
        cache_write: u64,
        output: u64,
        ts: i64,
    }

    for record in &lines {
        let payload = match record.get("payload") {
            Some(p) => p,
            None => continue,
        };
        let rec_type = record.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if rec_type == "session_meta" {
            if let Some(m) = payload.get("model").and_then(|v| v.as_str()) {
                model = Some(m.to_string());
            }
            if let Some(s) = payload.get("session_id").and_then(|v| v.as_str()) {
                session_id = s.to_string();
            }
            if let Some(ts) = record.get("timestamp").and_then(|v| v.as_str()) {
                last_ts = parse_ts(ts);
            }
        } else if rec_type == "turn_context" {
            if let Some(m) = payload.get("model").and_then(|v| v.as_str()) {
                model = Some(m.to_string());
            }
        } else if rec_type == "event_msg" {
            let payload_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if payload_type != "token_count" {
                continue;
            }
            let info = payload.get("info").unwrap_or(payload);

            if let Some(total) = info.get("total_token_usage") {
                last_total = Some(total.clone());
            }

            if let Some(last) = info.get("last_token_usage") {
                if let Some(total) = info.get("total_token_usage") {
                    let snapshot = CodexUsageSnapshot::from_usage(last, total);
                    if !seen_snapshots.insert(snapshot) {
                        continue;
                    }
                }

                let l_input = usage_tokens(last, "input_tokens");
                let l_cached = cached_input_tokens(last);
                let l_cache_write = usage_tokens(last, "cache_write_input_tokens");
                let l_output = usage_tokens(last, "output_tokens")
                    .saturating_add(usage_tokens(last, "reasoning_output_tokens"));

                let day_ts = record
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .map(parse_ts)
                    .unwrap_or(last_ts);
                last_ts = day_ts;
                let key = local_day_key(day_ts);

                let acc = by_day.entry(key.clone()).or_insert(CodexDayAcc {
                    input: 0,
                    cached_input: 0,
                    cache_write: 0,
                    output: 0,
                    ts: day_ts,
                });
                acc.input += l_input;
                acc.cached_input += l_cached;
                acc.cache_write += l_cache_write;
                acc.output += l_output;
                saw_last = true;
            }
        }
    }

    let model_name = model.unwrap_or_else(|| "gpt-5-codex".to_string());

    if saw_last {
        for (key, acc) in &by_day {
            let non_cached_input = acc.input.saturating_sub(acc.cached_input);
            if non_cached_input == 0 && acc.output == 0 && acc.cache_write == 0 && acc.cached_input == 0 {
                continue;
            }
            let cost = super::pricing::calc_cost(
                non_cached_input,
                acc.output,
                acc.cache_write,
                acc.cached_input,
                &model_name,
            );
            let estimated = !super::pricing::is_free(&super::pricing::match_model(&model_name));
            events.push(TokenEvent {
                tool: "codex".to_string(),
                model: model_name.clone(),
                model_label: String::new(),
                input: non_cached_input,
                output: acc.output,
                cache_write: acc.cache_write,
                cache_read: acc.cached_input,
                cost,
                estimated,
                day_key: key.clone(),
                dedupe_key: format!("codex:{}:{}", session_id, key),
                session_id: session_id.clone(),
                timestamp: acc.ts,
            });
        }
    } else if let Some(total) = last_total {
        let t_input = usage_tokens(&total, "input_tokens");
        let t_cached = cached_input_tokens(&total);
        let t_cache_write = usage_tokens(&total, "cache_write_input_tokens");
        let t_output = usage_tokens(&total, "output_tokens")
            .saturating_add(usage_tokens(&total, "reasoning_output_tokens"));
        let non_cached_input = t_input.saturating_sub(t_cached);
        if non_cached_input != 0 || t_output != 0 || t_cache_write != 0 || t_cached != 0 {
            let cost = super::pricing::calc_cost(non_cached_input, t_output, t_cache_write, t_cached, &model_name);
            let estimated = !super::pricing::is_free(&super::pricing::match_model(&model_name));
            events.push(TokenEvent {
                tool: "codex".to_string(),
                model: model_name.clone(),
                model_label: String::new(),
                input: non_cached_input,
                output: t_output,
                cache_write: t_cache_write,
                cache_read: t_cached,
                cost,
                estimated,
                day_key: local_day_key(last_ts),
                dedupe_key: format!("codex:{}", session_id),
                session_id: session_id.clone(),
                timestamp: last_ts,
            });
        }
    }

    events
}

// ═══════════════════════════════════════════════════════
// Pi 采集器
// 数据来源：~/.pi/agent/sessions/**/*.jsonl
// ═══════════════════════════════════════════════════════

pub fn collect_pi_events() -> Vec<TokenEvent> {
    let root = home_dir().join(".pi").join("agent").join("sessions");
    if !root.exists() {
        return Vec::new();
    }
    let files = list_jsonl_files_recursive(&root);
    let mut events = Vec::new();
    for file in &files {
        events.extend(parse_file_cached(file, parse_pi_file));
    }
    events
}

fn parse_pi_file(path: &Path) -> Vec<TokenEvent> {
    let lines = jsonl::read_jsonl(path);
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown");
    let mut events = Vec::new();

    for record in &lines {
        if record.get("type").and_then(|v| v.as_str()) != Some("message") {
            continue;
        }
        let msg = match record.get("message") {
            Some(m) => m,
            None => continue,
        };
        if msg.get("role").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let usage = match msg.get("usage") {
            Some(u) => u,
            None => continue,
        };
        let model = match msg.get("model").and_then(|v| v.as_str()) {
            Some(m) => m.to_string(),
            None => continue,
        };

        let input = usage.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_write = usage.get("cacheWrite").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = usage.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0);
        if input == 0 && output == 0 && cache_write == 0 && cache_read == 0 {
            continue;
        }

        let ts = record.get("timestamp").and_then(|v| v.as_str()).map(parse_ts).unwrap_or(0);
        let msg_id = record.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let session_id = if !msg_id.is_empty() {
            msg_id.to_string()
        } else {
            file_stem.to_string()
        };

        let cost = super::pricing::calc_cost(input, output, cache_write, cache_read, &model);
        let estimated = !super::pricing::is_free(&super::pricing::match_model(&model));

        events.push(TokenEvent {
            tool: "pi".to_string(),
            model,
            model_label: String::new(),
            input,
            output,
            cache_write,
            cache_read,
            cost,
            estimated,
            day_key: local_day_key(ts),
            dedupe_key: format!("pi:{}", msg_id),
            session_id,
            timestamp: ts,
        });
    }
    events
}

// ═══════════════════════════════════════════════════════
// Grok Build 采集器
// 数据来源：~/.grok/sessions/<编码cwd>/<sessionId>/updates.jsonl
// ═══════════════════════════════════════════════════════

pub fn collect_grok_events() -> Vec<TokenEvent> {
    let root = home_dir().join(".grok").join("sessions");
    if !root.exists() {
        return Vec::new();
    }
    let mut events = Vec::new();
    // Grok 结构：sessions/<encoded_cwd>/<sessionId>/updates.jsonl — 需递归查找
    collect_grok_updates(&root, &mut events);
    events
}

fn collect_grok_updates(dir: &Path, events: &mut Vec<TokenEvent>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_grok_updates(&path, events);
            } else if path.file_name().and_then(|s| s.to_str()) == Some("updates.jsonl") {
                events.extend(parse_file_cached(&path, parse_grok_file));
            }
        }
    }
}

pub fn parse_grok_file(path: &Path) -> Vec<TokenEvent> {
    let lines = jsonl::read_jsonl(path);
    let session_id = path
        .parent()
        .and_then(|p| p.file_stem())
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();

    let mut by_model: HashMap<String, GrokAcc> = HashMap::new();
    let mut ts: i64 = 0;

    struct GrokAcc {
        input: u64,
        output: u64,
        cache_read: u64,
    }

    for record in &lines {
        let params = match record.get("params") {
            Some(p) => p,
            None => continue,
        };
        let update = match params.get("update") {
            Some(u) => u,
            None => continue,
        };
        if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("turn_completed") {
            continue;
        }
        let usage = match update.get("usage") {
            Some(u) => u,
            None => continue,
        };

        // 优先按 modelUsage 分模型
        if let Some(model_usage) = usage.get("modelUsage").and_then(|v| v.as_object()) {
            for (model, mu) in model_usage {
                let acc = by_model
                    .entry(model.clone())
                    .or_insert(GrokAcc { input: 0, output: 0, cache_read: 0 });
                acc.input += mu.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                acc.output += mu.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0)
                    + mu.get("reasoningTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                acc.cache_read += mu.get("cachedReadTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            }
        } else {
            let acc = by_model
                .entry("grok".to_string())
                .or_insert(GrokAcc { input: 0, output: 0, cache_read: 0 });
            acc.input += usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            acc.output += usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0)
                + usage.get("reasoningTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            acc.cache_read += usage.get("cachedReadTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        }

        if let Some(t) = record.get("timestamp").and_then(|v| v.as_i64()) {
            ts = t * 1000; // 秒 → 毫秒
        }
    }

    let mut events = Vec::new();
    for (model, acc) in &by_model {
        let non_cached_input = acc.input.saturating_sub(acc.cache_read);
        if non_cached_input == 0 && acc.output == 0 && acc.cache_read == 0 {
            continue;
        }
        let cost = super::pricing::calc_cost(non_cached_input, acc.output, 0, acc.cache_read, model);
        let estimated = !super::pricing::is_free(&super::pricing::match_model(model));

        events.push(TokenEvent {
            tool: "grok".to_string(),
            model: model.clone(),
            model_label: String::new(),
            input: non_cached_input,
            output: acc.output,
            cache_write: 0,
            cache_read: acc.cache_read,
            cost,
            estimated,
            day_key: local_day_key(ts),
            dedupe_key: format!("grok:{}:{}", session_id, model),
            session_id: session_id.clone(),
            timestamp: ts,
        });
    }
    events
}
