// 核心模块集成测试：pricing + aggregator + jsonl/collectors
// 对应原始 JS 测试：calculator.test.js, aggregator.test.js, collectors.test.js, sources.test.js

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;

// 被测模块
use token_record_lib::core::pricing;
use token_record_lib::core::types::*;
use token_record_lib::core::jsonl;
use token_record_lib::core::aggregator;
use token_record_lib::core::collectors;

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
    e.estimated = pricing::is_estimated(&e.model);
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
    let matched = pricing::match_model("claude-opus-4-2026");
    assert_eq!(matched, "claude-opus-4");
}

#[test]
fn test_pricing_match_supplier_claude_opus() {
    let matched = pricing::match_model("claude-opus-4-8");
    assert_eq!(matched, "claude-opus-4-8");
}

#[test]
fn test_pricing_match_claude_fable() {
    let matched = pricing::match_model("claude-fable-5-20260609");
    assert_eq!(matched, "claude-fable-5");
    assert!(!pricing::is_estimated("claude-fable-5-20260609"));
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
    assert!(pricing::is_estimated("totally-unknown-model-xyz"));
}

#[test]
fn test_pricing_calc_claude_opus() {
    let cost = pricing::calc_cost(76498, 63838, 222615, 1615445, "claude-opus-4-2026");
    // 76498*15 + 63838*75 + 222615*18.75 + 1615445*1.5 = 12,532,518.75 (per million)
    let expected = 12.53251875;
    assert!((cost - expected).abs() < 0.0001, "cost={} expected={}", cost, expected);
}

#[test]
fn test_pricing_calc_supplier_claude_opus() {
    let cost = pricing::calc_cost(2, 272, 350, 413851, "claude-opus-4-8");
    assert!(
        (cost - 0.215923).abs() < f64::EPSILON,
        "cost={} expected=0.215923",
        cost
    );
}

#[test]
fn test_pricing_calc_claude_fable() {
    let cost = pricing::calc_cost(2, 272, 350, 413851, "claude-fable-5-20260609");
    assert!(
        (cost - 0.431846).abs() < f64::EPSILON,
        "cost={} expected=0.431846",
        cost
    );
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
fn test_aggregator_dedup_keeps_later_complete_streaming_event() {
    let early = ev(HashMap::from([
        ("dedupe_key", "streaming-message"),
        ("input", "16896"),
    ]));
    let mut complete = ev(HashMap::from([
        ("dedupe_key", "streaming-message"),
        ("input", "41709"),
        ("output", "108"),
        ("cache_read", "38016"),
    ]));
    complete.timestamp = 1;

    let snap = aggregator::aggregate(&[early, complete]);
    let tokens = &snap.tools.get("claude").unwrap().tokens;
    assert_eq!(tokens.input, 41709);
    assert_eq!(tokens.output, 108);
    assert_eq!(tokens.cache_read, 38016);
    assert_eq!(tokens.total, 79833);
}

#[test]
fn test_aggregator_dedup_keeps_more_complete_same_timestamp_event() {
    let early = ev(HashMap::from([
        ("dedupe_key", "same-timestamp-message"),
        ("input", "10"),
    ]));
    let complete = ev(HashMap::from([
        ("dedupe_key", "same-timestamp-message"),
        ("input", "10"),
        ("output", "20"),
        ("cache_read", "30"),
    ]));

    let snap = aggregator::aggregate(&[early, complete]);
    assert_eq!(snap.tools.get("claude").unwrap().total, 60);
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

#[test]
fn test_build_period_uses_supplied_today_key_for_day_window() {
    let mut by_day = HashMap::new();
    by_day.insert(
        "2024-02-23".to_string(),
        DayData {
            tokens: ToolTokens {
                input: 10,
                total: 10,
                ..Default::default()
            },
            total: 10,
            cost: 0.1,
            ..Default::default()
        },
    );
    by_day.insert(
        "2024-02-29".to_string(),
        DayData {
            tokens: ToolTokens {
                input: 70,
                total: 70,
                ..Default::default()
            },
            total: 70,
            cost: 0.7,
            ..Default::default()
        },
    );

    let period = aggregator::build_period(&by_day, "2024-02-29");

    assert_eq!(period.today_key, "2024-02-29");
    assert_eq!(period.days.len(), 7);
    assert_eq!(period.days.first().unwrap().date, "2024-02-23");
    assert_eq!(period.days.last().unwrap().date, "2024-02-29");
    assert_eq!(period.today.total, 70);
    assert_eq!(period.last7.total, 80);
    assert!((period.last7_cost - 0.8).abs() < f64::EPSILON);
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

fn codex_token_count(last: serde_json::Value, total: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "type": "event_msg",
        "timestamp": "2026-07-30T12:00:00Z",
        "payload": {
            "type": "token_count",
            "info": {
                "last_token_usage": last,
                "total_token_usage": total
            }
        }
    })
}

fn codex_session_meta() -> serde_json::Value {
    serde_json::json!({
        "type": "session_meta",
        "timestamp": "2026-07-30T12:00:00Z",
        "payload": { "model": "gpt-5", "session_id": "codex-test" }
    })
}

#[test]
fn test_codex_complete_replay_counted_once_and_reasoning_is_output() {
    let last = serde_json::json!({
        "input_tokens": 100,
        "cached_input_tokens": 20,
        "cache_write_input_tokens": 30,
        "output_tokens": 40,
        "reasoning_output_tokens": 50,
        "total_tokens": 240
    });
    let total = serde_json::json!({
        "input_tokens": 100,
        "cached_input_tokens": 20,
        "cache_write_input_tokens": 30,
        "output_tokens": 40,
        "reasoning_output_tokens": 50,
        "total_tokens": 240
    });
    let p = tmp_file("codex-complete-replay.jsonl", &[
        codex_session_meta(),
        codex_token_count(last.clone(), total.clone()),
        codex_token_count(last, total),
    ]);

    let events = collectors::parse_codex_file(&p);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.input, 80);
    assert_eq!(event.cache_write, 30);
    assert_eq!(event.cache_read, 20);
    assert_eq!(event.output, 90, "推理 token 必须计入输出");
    assert_eq!(event.cost, pricing::calc_cost(80, 90, 30, 20, "gpt-5"));
}

#[test]
fn test_codex_same_total_with_different_last_is_not_deduplicated() {
    let total = serde_json::json!({
        "input_tokens": 300,
        "cached_input_tokens": 0,
        "cache_write_input_tokens": 0,
        "output_tokens": 0,
        "reasoning_output_tokens": 0,
        "total_tokens": 300
    });
    let p = tmp_file("codex-same-total-different-last.jsonl", &[
        codex_session_meta(),
        codex_token_count(serde_json::json!({
            "input_tokens": 100, "cached_input_tokens": 0, "cache_write_input_tokens": 0,
            "output_tokens": 0, "reasoning_output_tokens": 0, "total_tokens": 100
        }), total.clone()),
        codex_token_count(serde_json::json!({
            "input_tokens": 200, "cached_input_tokens": 0, "cache_write_input_tokens": 0,
            "output_tokens": 0, "reasoning_output_tokens": 0, "total_tokens": 200
        }), total),
    ]);

    let events = collectors::parse_codex_file(&p);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].input, 300);
}

#[test]
fn test_grok_reasoning_is_output() {
    let p = tmp_file("grok-reasoning.jsonl", &[serde_json::json!({
        "timestamp": 1785412800,
        "params": {
            "update": {
                "sessionUpdate": "turn_completed",
                "usage": {
                    "modelUsage": {
                        "grok-4": {
                            "inputTokens": 100,
                            "cachedReadTokens": 20,
                            "outputTokens": 30,
                            "reasoningTokens": 40
                        }
                    }
                }
            }
        }
    })]);

    let events = collectors::parse_grok_file(&p);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].input, 80);
    assert_eq!(events[0].output, 70, "推理 token 必须计入输出");
    assert_eq!(events[0].cost, pricing::calc_cost(80, 70, 0, 20, "grok-4"));
}

// ── 按日历史合并语义 ──

fn day_tool(total: u64, cost: f64) -> token_record_lib::core::types::DayToolStat {
    token_record_lib::core::types::DayToolStat {
        input: total,
        output: 0,
        cache_write: 0,
        cache_read: 0,
        total,
        cost,
        estimated: false,
    }
}

fn day_data(tool: &str, total: u64, cost: f64) -> token_record_lib::core::types::DayData {
    let mut d = token_record_lib::core::types::DayData::default();
    d.tools.insert(tool.to_string(), day_tool(total, cost));
    d.total = total;
    d.cost = cost;
    d
}

#[test]
fn test_history_merge_new_day_added() {
    use token_record_lib::core::history;
    let mut hist = history::History::new();
    let by_day = HashMap::from([("2026-07-28".to_string(), day_data("claude", 100, 1.0))]);
    history::merge(&mut hist, &by_day, 1000);
    assert_eq!(hist["2026-07-28"].tools["claude"].total, 100);
    assert_eq!(hist["2026-07-28"].updated_at, 1000);
}

#[test]
fn test_history_merge_pruned_day_kept() {
    use token_record_lib::core::history;
    let mut hist = history::History::new();
    let old = HashMap::from([("2026-06-01".to_string(), day_data("codex", 500, 5.0))]);
    history::merge(&mut hist, &old, 1);
    // 源清理后，当前扫描不再包含 2026-06-01
    let now = HashMap::from([("2026-07-28".to_string(), day_data("codex", 100, 1.0))]);
    history::merge(&mut hist, &now, 2);
    assert_eq!(hist["2026-06-01"].tools["codex"].total, 500, "被源清理的天必须保留");
    assert_eq!(hist["2026-07-28"].tools["codex"].total, 100);
}

#[test]
fn test_history_merge_growth_replaces_shrink_keeps() {
    use token_record_lib::core::history;
    let mut hist = history::History::new();
    let first = HashMap::from([("2026-07-28".to_string(), day_data("pi", 300, 3.0))]);
    history::merge(&mut hist, &first, 1);
    // 正常追加：磁盘值增大 → 覆盖
    let grow = HashMap::from([("2026-07-28".to_string(), day_data("pi", 450, 4.5))]);
    history::merge(&mut hist, &grow, 2);
    assert_eq!(hist["2026-07-28"].tools["pi"].total, 450);
    // 源被部分清理：磁盘值变小 → 保留较大已记录值
    let shrink = HashMap::from([("2026-07-28".to_string(), day_data("pi", 50, 0.5))]);
    history::merge(&mut hist, &shrink, 3);
    assert_eq!(hist["2026-07-28"].tools["pi"].total, 450, "缩水的磁盘值不得覆盖历史");
}

#[test]
fn test_history_merge_multi_tool_same_day() {
    use token_record_lib::core::history;
    let mut hist = history::History::new();
    let a = HashMap::from([("2026-07-28".to_string(), day_data("claude", 100, 1.0))]);
    history::merge(&mut hist, &a, 1);
    let b = HashMap::from([("2026-07-28".to_string(), day_data("grok", 200, 2.0))]);
    history::merge(&mut hist, &b, 2);
    assert_eq!(hist["2026-07-28"].tools["claude"].total, 100);
    assert_eq!(hist["2026-07-28"].tools["grok"].total, 200);
}

#[test]
fn test_history_correct_codex_records_allows_verified_decrease() {
    use token_record_lib::core::history;
    let mut hist = history::History::new();
    history::merge(
        &mut hist,
        &HashMap::from([("2026-07-28".to_string(), day_data("codex", 900, 9.0))]),
        1,
    );
    let visible = HashMap::from([("2026-07-28".to_string(), day_data("codex", 600, 6.0))]);

    assert!(history::correct_codex_records(&mut hist, &visible, 2));
    assert_eq!(hist["2026-07-28"].tools["codex"].total, 600);
    assert_eq!(hist["2026-07-28"].tools["codex"].cost, 6.0);
}
