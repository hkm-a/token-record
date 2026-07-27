// 核心模块集成测试：pricing + aggregator + jsonl/collectors
// 对应原始 JS 测试：calculator.test.js, aggregator.test.js, collectors.test.js, sources.test.js

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

// 被测模块
use token_record_lib::core::pricing;
use token_record_lib::core::types::*;
use token_record_lib::core::jsonl;
use token_record_lib::core::aggregator;

// ── 辅助函数 ──

fn ev(overrides: HashMap<&str, &str>) -> TokenEvent {
    let mut e = TokenEvent {
        tool: "claude".to_string(),
        model: "claude-opus-4-8".to_string(),
        model_label: String::new(),
        input: 100,
        output: 0,
        cache_write: 0,
        cache_read: 0,
        cost: 0.0,
        estimated: false,
        day_key: chrono::Local::now().format("%Y-%m-%d").to_string(),
        dedupe_key: "k1".to_string(),
        session_id: String::new(),
        timestamp: 0,
    };
    for (k, v) in overrides {
        match k {
            "tool" => e.tool = v.to_string(),
            "model" => e.model = v.to_string(),
            "dedupe_key" => e.dedupe_key = v.to_string(),
            "session_id" => e.session_id = v.to_string(),
            "day_key" => e.day_key = v.to_string(),
            "input" => e.input = v.parse().unwrap_or(100),
            "output" => e.output = v.parse().unwrap_or(0),
            "cache_write" => e.cache_write = v.parse().unwrap_or(0),
            "cache_read" => e.cache_read = v.parse().unwrap_or(0),
            _ => {}
        }
    }
    e.cost = pricing::calc_cost(e.input, e.output, e.cache_write, e.cache_read, &e.model);
    e.estimated = !pricing::is_free(&pricing::match_model(&e.model));
    e
}

fn tmp_file(name: &str, lines: &[serde_json::Value]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tokenrec-test-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(name);
    let mut f = std::fs::File::create(&path).unwrap();
    for line in lines {
        writeln!(f, "{}", serde_json::to_string(line).unwrap()).unwrap();
    }
    path
}

// ═══════════════════════════════════════════════════════
// Pricing / 计价器
// ═══════════════════════════════════════════════════════

#[test]
fn test_pricing_match_claude_opus() {
    let matched = pricing::match_model("claude-opus-4-8");
    assert_eq!(matched, "claude-opus-4");
}

#[test]
fn test_pricing_match_gpt_custom() {
    let matched = pricing::match_model("gpt-5.6-terra");
    assert_eq!(matched, "gpt-5");
}

#[test]
fn test_pricing_is_free() {
    assert_eq!(pricing::is_free("grok-4.5-build-free"), true);
}

#[test]
fn test_pricing_default_fallback() {
    let matched = pricing::match_model("totally-unknown-model-xyz");
    assert_eq!(matched, "default");
    assert_eq!(pricing::is_free("default"), false);
}

#[test]
fn test_pricing_calc_claude_opus() {
    let cost = pricing::calc_cost(76498, 63838, 222615, 1615445, "claude-opus-4-8");
    // 76498*15 + 63838*75 + 222615*18.75 + 1615445*1.5 = 12,532,518.75 (per million)
    let expected = 12.53251875;
    assert!((cost - expected).abs() < 0.0001, "cost={} expected={}", cost, expected);
}

#[test]
fn test_pricing_free_cost_zero() {
    let cost = pricing::calc_cost(1000, 2000, 0, 5000, "grok-4.5-build-free");
    assert_eq!(cost, 0.0);
}

// ═══════════════════════════════════════════════════════
// Aggregator / 聚合器
// ═══════════════════════════════════════════════════════

#[test]
fn test_aggregator_dedup_same_key_once() {
    let events = vec![ev(HashMap::new()), ev(HashMap::new())];
    let snap = aggregator::aggregate(&events);
    assert_eq!(snap.tools.get("claude").unwrap().tokens.input, 100);
}

#[test]
fn test_aggregator_per_tool_and_grand() {
    let events = vec![
        ev(HashMap::from([("tool", "claude"), ("dedupe_key", "a"), ("input", "100")])),
        ev(HashMap::from([("tool", "grok"), ("model", "grok-4.5-build-free"), ("dedupe_key", "b"), ("input", "200")])),
    ];
    let snap = aggregator::aggregate(&events);
    assert_eq!(snap.tools.get("claude").unwrap().tokens.input, 100);
    assert_eq!(snap.tools.get("grok").unwrap().tokens.input, 200);
    assert_eq!(snap.grand.tokens.input, 300);
}

#[test]
fn test_aggregator_session_count() {
    let events = vec![
        ev(HashMap::from([("dedupe_key", "x"), ("session_id", "s1")])),
        ev(HashMap::from([("dedupe_key", "y"), ("session_id", "s1")])),
        ev(HashMap::from([("dedupe_key", "z"), ("session_id", "s2")])),
    ];
    let snap = aggregator::aggregate(&events);
    assert_eq!(snap.tools.get("claude").unwrap().session_count, 2);
}

#[test]
fn test_aggregator_estimated_flag() {
    let events = vec![
        ev(HashMap::from([("tool", "codex"), ("model", "gpt-5.6-terra"), ("dedupe_key", "e")])),
    ];
    let snap = aggregator::aggregate(&events);
    assert_eq!(snap.tools.get("codex").unwrap().estimated, true);
    assert_eq!(snap.grand.estimated, true);
}

#[test]
fn test_aggregator_by_day() {
    let today_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    let yesterday_key = (chrono::Local::now() - chrono::Duration::days(1))
        .format("%Y-%m-%d").to_string();

    let events = vec![
        ev(HashMap::from([("dedupe_key", "d1"), ("input", "100"), ("tool", "claude"), ("day_key", &today_key)])),
        ev(HashMap::from([("dedupe_key", "d2"), ("input", "400"), ("tool", "codex"), ("model", "gpt-5"), ("day_key", &yesterday_key)])),
    ];
    let snap = aggregator::aggregate(&events);

    assert!(snap.by_day.contains_key(&today_key));
    assert!(snap.by_day.contains_key(&yesterday_key));
    assert_eq!(snap.by_day[&today_key].total, 100);
    assert_eq!(snap.by_day[&yesterday_key].total, 400);
    assert_eq!(snap.by_day[&today_key].tools.get("claude").unwrap().total, 100);
    assert_eq!(snap.by_day[&yesterday_key].tools.get("codex").unwrap().total, 400);
}

#[test]
fn test_aggregator_period() {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let yesterday = (chrono::Local::now() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let three_days_ago = (chrono::Local::now() - chrono::Duration::days(3)).format("%Y-%m-%d").to_string();

    let events = vec![
        ev(HashMap::from([("dedupe_key", "t"), ("input", "100"), ("tool", "claude"), ("day_key", &today)])),
        ev(HashMap::from([("dedupe_key", "y1"), ("input", "200"), ("tool", "claude"), ("day_key", &yesterday)])),
        ev(HashMap::from([("dedupe_key", "y3"), ("input", "300"), ("model", "grok-4.5-build-free"), ("tool", "grok"), ("day_key", &three_days_ago)])),
    ];
    let snap = aggregator::aggregate(&events);

    // today
    assert_eq!(snap.period.today.total, 100);
    assert_eq!(snap.period.today_key, today);

    // last7 = sum of events within 7 days = 100 + 200 + 300 = 600
    assert_eq!(snap.period.last7.total, 600);
}

// ═══════════════════════════════════════════════════════
// JSONL / 采集器
// ═══════════════════════════════════════════════════════

#[test]
fn test_jsonl_read_empty_file() {
    let p = tmp_file("empty.jsonl", &[]);
    let result = jsonl::read_jsonl(&p);
    assert_eq!(result.len(), 0);
}

#[test]
fn test_jsonl_read_valid_lines() {
    let p = tmp_file("valid.jsonl", &[
        serde_json::json!({"a": 1}),
        serde_json::json!({"b": 2}),
    ]);
    let result = jsonl::read_jsonl(&p);
    assert_eq!(result.len(), 2);
    assert_eq!(result[0]["a"], 1);
}

#[test]
fn test_jsonl_skip_empty_lines() {
    let path = {
        let dir = std::env::temp_dir().join(format!("tokenrec-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("mixed.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        writeln!(f, "{{\"a\":1}}").unwrap();
        writeln!(f, "").unwrap();
        writeln!(f, "{{\"b\":2}}").unwrap();
        p
    };
    let result = jsonl::read_jsonl(&path);
    assert_eq!(result.len(), 2);
}
