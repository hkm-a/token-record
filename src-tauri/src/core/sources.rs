use super::collectors::{home_dir, list_jsonl_files, list_jsonl_files_recursive};
use super::types::{SourceInfo, SourcesResult};
use std::collections::HashMap;
use std::path::PathBuf;

struct ProbeDef {
    key: &'static str,
    label: &'static str,
    root: fn() -> PathBuf,
    hint: &'static str,
    how: &'static str,
    recursive: bool,
    filename_filter: Option<&'static str>,
}

const PROBES: &[ProbeDef] = &[
    ProbeDef {
        key: "claude",
        label: "Claude Code",
        root: || home_dir().join(".claude").join("projects"),
        hint: "~/.claude/projects/*/*.jsonl",
        how: "使用 Claude Code 产生会话后会出现用量",
        recursive: false,
        filename_filter: None,
    },
    ProbeDef {
        key: "codex",
        label: "Codex",
        root: || home_dir().join(".codex").join("sessions"),
        hint: "~/.codex/sessions/**/*.jsonl",
        how: "使用 Codex 产生会话后会出现用量",
        recursive: true,
        filename_filter: None,
    },
    ProbeDef {
        key: "pi",
        label: "Pi",
        root: || home_dir().join(".pi").join("agent").join("sessions"),
        hint: "~/.pi/agent/sessions/**/*.jsonl",
        how: "使用 Pi 产生会话后会出现用量",
        recursive: true,
        filename_filter: None,
    },
    ProbeDef {
        key: "grok",
        label: "Grok Build",
        root: || home_dir().join(".grok").join("sessions"),
        hint: "~/.grok/sessions/**/updates.jsonl",
        how: "使用 Grok Build 产生会话后会出现用量",
        recursive: false,
        filename_filter: Some("updates.jsonl"),
    },
];

pub fn probe_sources() -> SourcesResult {
    let mut tools = HashMap::new();
    let mut total_files = 0u64;
    let mut missing = 0u64;
    let mut empty = 0u64;
    let mut errors = 0u64;
    let mut issues = Vec::new();
    let mut all_quiet = true;

    for probe in PROBES {
        let root = (probe.root)();
        let exists = root.exists();

        let file_count = if exists {
            if probe.recursive {
                list_jsonl_files_recursive(&root).len() as u64
            } else {
                list_jsonl_files(&root).len() as u64
            }
        } else {
            0
        };

        let (status, message) = if !exists {
            missing += 1;
            all_quiet = false;
            ("missing".to_string(), format!("目录 {} 未创建", root.display()))
        } else if file_count == 0 {
            empty += 1;
            ("empty".to_string(), "目录已创建但尚未有会话文件".to_string())
        } else {
            ("ok".to_string(), format!("{} 个会话文件", file_count))
        };

        tools.insert(
            probe.key.to_string(),
            SourceInfo {
                key: probe.key.to_string(),
                label: probe.label.to_string(),
                root: root.display().to_string(),
                hint: probe.hint.to_string(),
                how: probe.how.to_string(),
                exists,
                file_count,
                status,
                message,
            },
        );

        total_files += file_count;
    }

    let banner = if all_quiet && total_files == 0 {
        "暂无数据：所有数据源均为空状态。请先使用 AI 编码工具产生一些会话记录。".to_string()
    } else {
        String::new()
    };

    SourcesResult {
        tools,
        total_files,
        missing,
        empty,
        errors,
        all_quiet,
        banner,
        issues,
    }
}
