use super::jsonl;
use super::types::TokenEvent;
use chrono::Local;
use std::path::{Path, PathBuf};

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

/// Home 目录辅助
pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("C:\\Users\\default"))
}

// ── 特定 Collector 实现 ──

/// Claude Code collector
/// 目录: ~/.claude/projects/*/*.jsonl
pub fn collect_claude_events() -> Vec<TokenEvent> {
    let root = home_dir().join(".claude").join("projects");
    let mut events = Vec::new();
    if !root.exists() {
        return events;
    }
    // 遍历 ~/.claude/projects/*/*.jsonl
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
    let mut events = Vec::new();
    let day_key = Local::now().format("%Y-%m-%d").to_string();

    for line in &lines {
        // 跳过合成/系统消息
        if line.get("role").and_then(|r| r.as_str()) == Some("assistant")
            && line.get("synthetic").and_then(|s| s.as_bool()) == Some(true)
        {
            continue;
        }

        let usage = match line.get("usage") {
            Some(u) => u,
            None => continue,
        };

        let input = usage.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_write = usage.get("cache_write").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = usage.get("cache_read").and_then(|v| v.as_u64()).unwrap_or(0);
        let model = line
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let session_id = line
            .get("session_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let dedupe_key = format!("claude-{}", session_id);

        let cost = super::pricing::calc_cost(input, output, cache_write, cache_read, &model);
        let estimated = !super::pricing::is_free(&super::pricing::match_model(&model));

        events.push(TokenEvent {
            tool: "claude".to_string(),
            model: model.clone(),
            model_label: "".to_string(),
            input,
            output,
            cache_write,
            cache_read,
            cost,
            estimated,
            day_key: day_key.clone(),
            dedupe_key,
            session_id,
            timestamp: 0,
        });
    }
    events
}

/// Codex collector
/// 目录: ~/.codex/sessions/**/*.jsonl
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
    let mut events = Vec::new();
    let day_key = Local::now().format("%Y-%m-%d").to_string();
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown");

    let mut last_total: Option<serde_json::Value> = None;
    let mut last_usage: Option<(u64, u64)> = None; // (input, output)

    for line in &lines {
        // Token 使用事件
        if let Some(usage) = line.get("last_token_usage") {
            let input = usage
                .get("input")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let output = usage
                .get("output")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            last_usage = Some((input, output));
        }

        // 保存最后的 total 快照作为 fallback
        if let Some(total) = line.get("total_tokens") {
            last_total = Some(total.clone());
        }

        // 记录事件（每行一个）
        let session_id = format!("codex-{}", file_stem);
        let dedupe_key = format!("codex-{}-{}", file_stem, line.get("id").and_then(|v| v.as_u64()).unwrap_or(0));

        let (input, output) = last_usage.unwrap_or((0, 0));
        let cache_write = 0u64;
        let cache_read = 0u64;
        let model = line
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();

        let cost = super::pricing::calc_cost(input, output, 0, 0, &model);
        let estimated = !super::pricing::is_free(&super::pricing::match_model(&model));

        events.push(TokenEvent {
            tool: "codex".to_string(),
            model,
            model_label: "".to_string(),
            input,
            output,
            cache_write,
            cache_read,
            cost,
            estimated,
            day_key: day_key.clone(),
            dedupe_key,
            session_id,
            timestamp: 0,
        });
    }

    // 如果没有 last_token_usage 事件，退化为取最后一个 total 快照
    if last_usage.is_none() {
        if let Some(total) = last_total {
            let total_val = total.as_u64().unwrap_or(0);
            let model = "default".to_string();
            let cost = super::pricing::calc_cost(total_val, 0, 0, 0, &model);
            let dedupe_key = format!("codex-{}-total", file_stem);
            events.push(TokenEvent {
                tool: "codex".to_string(),
                model,
                model_label: "".to_string(),
                input: total_val,
                output: 0,
                cache_write: 0,
                cache_read: 0,
                cost,
                estimated: true,
                day_key,
                dedupe_key,
                session_id: format!("codex-{}", file_stem),
                timestamp: 0,
            });
        }
    }

    events
}

/// Pi collector
/// 目录: ~/.pi/agent/sessions/**/*.jsonl
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
    let mut events = Vec::new();
    let day_key = Local::now().format("%Y-%m-%d").to_string();
    let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown");

    for line in &lines {
        let role = line.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role != "assistant" {
            continue;
        }

        let usage = match line.get("usage") {
            Some(u) => u,
            None => continue,
        };

        let input = usage.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
        let model = line
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();
        let cache_write = usage.get("cache_write").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = usage.get("cache_read").and_then(|v| v.as_u64()).unwrap_or(0);
        let msg_id = line
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let dedupe_key = format!("pi-{}-{}", file_stem, msg_id);
        let cost = super::pricing::calc_cost(input, output, cache_write, cache_read, &model);
        let estimated = !super::pricing::is_free(&super::pricing::match_model(&model));

        events.push(TokenEvent {
            tool: "pi".to_string(),
            model,
            model_label: "".to_string(),
            input,
            output,
            cache_write,
            cache_read,
            cost,
            estimated,
            day_key: day_key.clone(),
            dedupe_key,
            session_id: format!("pi-{}", file_stem),
            timestamp: 0,
        });
    }
    events
}

/// Grok collector
/// 目录: ~/.grok/sessions/**/updates.jsonl
pub fn collect_grok_events() -> Vec<TokenEvent> {
    let root = home_dir().join(".grok").join("sessions");
    if !root.exists() {
        return Vec::new();
    }

    let mut events = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let session_dir = entry.path();
            if session_dir.is_dir() {
                let updates_file = session_dir.join("updates.jsonl");
                if updates_file.exists() {
                    events.extend(parse_grok_file(&updates_file));
                }
            }
        }
    }
    events
}

fn parse_grok_file(path: &Path) -> Vec<TokenEvent> {
    let lines = jsonl::read_jsonl(path);
    let mut events = Vec::new();
    let day_key = Local::now().format("%Y-%m-%d").to_string();

    for line in &lines {
        // Grok 的 turn_completed 事件
        let turn = match line.get("turn_completed") {
            Some(t) => t,
            None => continue,
        };

        let usage = match turn.get("usage") {
            Some(u) => u,
            None => continue,
        };

        let input = usage.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_write = usage.get("cache_write").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = usage.get("cache_read").and_then(|v| v.as_u64()).unwrap_or(0);
        let model = turn
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("default")
            .to_string();
        let turn_id = turn
            .get("id")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let dedupe_key = format!(
            "grok-{}-{}",
            path.parent().and_then(|p| p.file_stem()).and_then(|s| s.to_str()).unwrap_or("unknown"),
            turn_id
        );
        let cost = super::pricing::calc_cost(input, output, cache_write, cache_read, &model);
        let estimated = !super::pricing::is_free(&super::pricing::match_model(&model));

        events.push(TokenEvent {
            tool: "grok".to_string(),
            model,
            model_label: "".to_string(),
            input,
            output,
            cache_write,
            cache_read,
            cost,
            estimated,
            day_key: day_key.clone(),
            dedupe_key,
            session_id: "".to_string(),
            timestamp: 0,
        });
    }
    events
}
