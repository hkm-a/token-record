pub mod core;
pub mod config;

use core::types::SnapshotOutput;
use core::collectors;
use core::sources;
use core::aggregator;

/// 刷新数据（核心 tick 逻辑）— 被 GUI 和 CLI 共用
pub fn refresh() -> SnapshotOutput {
    let mut events = Vec::new();
    events.extend(collectors::collect_claude_events());
    events.extend(collectors::collect_codex_events());
    events.extend(collectors::collect_pi_events());
    events.extend(collectors::collect_grok_events());

    let mut snapshot = aggregator::aggregate(&events);
    snapshot.sources = sources::probe_sources();

    SnapshotOutput {
        snapshot,
        is_first: false,
        has_delta: true,
    }
}
