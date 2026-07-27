pub mod core;
pub mod config;

use core::types::{Delta, Snapshot, SnapshotOutput, ToolDelta};
use core::collectors;
use core::sources;
use core::aggregator;
use std::sync::Mutex;

/// 全局状态：缓存上一次快照用于 delta 计算
static LAST_SNAPSHOT: Mutex<Option<Snapshot>> = Mutex::new(None);

/// 刷新数据（核心 tick 逻辑）— 被 GUI 和 CLI 共用
pub fn refresh() -> SnapshotOutput {
    let mut events = Vec::new();
    events.extend(collectors::collect_claude_events());
    events.extend(collectors::collect_codex_events());
    events.extend(collectors::collect_pi_events());
    events.extend(collectors::collect_grok_events());

    let mut snapshot = aggregator::aggregate(&events);
    snapshot.sources = sources::probe_sources();

    // 计算 delta：与上一次快照对比
    let (is_first, delta) = {
        let last = LAST_SNAPSHOT.lock().unwrap();
        match last.as_ref() {
            None => (true, Delta::default()),
            Some(prev) => (false, compute_delta(prev, &snapshot)),
        }
    };

    // 保存当前快照
    {
        let mut last = LAST_SNAPSHOT.lock().unwrap();
        *last = Some(snapshot.clone());
    }

    SnapshotOutput {
        snapshot,
        delta,
        is_first,
    }
}

/// 计算两次快照的增量
fn compute_delta(prev: &Snapshot, curr: &Snapshot) -> Delta {
    let mut tools = std::collections::HashMap::new();
    let mut grand_token_delta: u64 = 0;
    let mut grand_cost_delta: f64 = 0.0;

    for (key, curr_tool) in &curr.tools {
        let prev_token = prev.tools.get(key).map(|t| t.total).unwrap_or(0);
        let prev_cost = prev.tools.get(key).map(|t| t.cost).unwrap_or(0.0);
        let token_delta = curr_tool.total.saturating_sub(prev_token);
        let cost_delta = curr_tool.cost - prev_cost;

        if token_delta > 0 || cost_delta.abs() > 0.001 {
            tools.insert(
                key.clone(),
                ToolDelta {
                    token_delta,
                    cost_delta,
                },
            );
        }
        grand_token_delta += token_delta;
        grand_cost_delta += cost_delta;
    }

    Delta {
        tools,
        grand_token_delta,
        grand_cost_delta,
    }
}
