use super::jsonl;
use super::types::TokenEvent;
use chrono::{Local, TimeZone, Utc};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
                    events.extend(parse_claude_file(&file));
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
        events.extend(parse_codex_file(file));
    }
    events
}

fn parse_codex_file(path: &Path) -> Vec<TokenEvent> {
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

    struct CodexDayAcc {
        input: u64,
        cached_input: u64,
        output: u64,
        reasoning: u64,
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
                let l_input = last.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let l_cached = last
                    .get("cached_input_tokens")
                    .or_else(|| last.get("cache_read_input_tokens"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let l_output = last.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let l_reasoning = last.get("reasoning_output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

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
                    output: 0,
                    reasoning: 0,
                    ts: day_ts,
                });
                acc.input += l_input;
                acc.cached_input += l_cached;
                acc.output += l_output;
                acc.reasoning += l_reasoning;
                saw_last = true;
            }
        }
    }

    let model_name = model.unwrap_or_else(|| "gpt-5-codex".to_string());

    if saw_last {
        for (key, acc) in &by_day {
            let non_cached_input = acc.input.saturating_sub(acc.cached_input);
            if non_cached_input == 0 && acc.output == 0 && acc.cached_input == 0 {
                continue;
            }
            let cost = super::pricing::calc_cost(non_cached_input, acc.output, 0, acc.cached_input, &model_name);
            let estimated = !super::pricing::is_free(&super::pricing::match_model(&model_name));
            events.push(TokenEvent {
                tool: "codex".to_string(),
                model: model_name.clone(),
                model_label: String::new(),
                input: non_cached_input,
                output: acc.output,
                cache_write: 0,
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
        let t_input = total.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let t_cached = total
            .get("cached_input_tokens")
            .or_else(|| total.get("cache_read_input_tokens"))
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let t_output = total.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let non_cached_input = t_input.saturating_sub(t_cached);
        if non_cached_input != 0 || t_output != 0 || t_cached != 0 {
            let cost = super::pricing::calc_cost(non_cached_input, t_output, 0, t_cached, &model_name);
            let estimated = !super::pricing::is_free(&super::pricing::match_model(&model_name));
            events.push(TokenEvent {
                tool: "codex".to_string(),
                model: model_name.clone(),
                model_label: String::new(),
                input: non_cached_input,
                output: t_output,
                cache_write: 0,
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
        events.extend(parse_pi_file(file));
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
                events.extend(parse_grok_file(&path));
            }
        }
    }
}

fn parse_grok_file(path: &Path) -> Vec<TokenEvent> {
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
        reasoning: u64,
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
                    .or_insert(GrokAcc { input: 0, output: 0, cache_read: 0, reasoning: 0 });
                acc.input += mu.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                acc.output += mu.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                acc.cache_read += mu.get("cachedReadTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                acc.reasoning += mu.get("reasoningTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            }
        } else {
            let acc = by_model
                .entry("grok".to_string())
                .or_insert(GrokAcc { input: 0, output: 0, cache_read: 0, reasoning: 0 });
            acc.input += usage.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            acc.output += usage.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            acc.cache_read += usage.get("cachedReadTokens").and_then(|v| v.as_u64()).unwrap_or(0);
            acc.reasoning += usage.get("reasoningTokens").and_then(|v| v.as_u64()).unwrap_or(0);
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
