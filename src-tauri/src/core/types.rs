use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Token 用量事件 ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenEvent {
    pub tool: String,
    pub model: String,
    #[serde(default)]
    pub model_label: String,
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_write: u64,
    #[serde(default)]
    pub cache_read: u64,
    pub cost: f64,
    pub estimated: bool,
    pub day_key: String,
    pub dedupe_key: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub timestamp: i64,
}

// ── 快照数据结构 ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolTokens {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolStats {
    pub tokens: ToolTokens,
    pub total: u64,
    pub cost: f64,
    pub estimated: bool,
    pub session_count: u64,
    pub models: HashMap<String, ModelStats>,
    #[serde(default)]
    pub today: TodayStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TodayStats {
    pub tokens: ToolTokens,
    pub total: u64,
    pub cost: f64,
    pub estimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStats {
    pub tokens: ToolTokens,
    pub total: u64,
    pub cost: f64,
    pub estimated: bool,
    pub matched: String,
    pub free: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GrandTotal {
    pub tokens: ToolTokens,
    pub total: u64,
    pub cost: f64,
    pub estimated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DayData {
    pub tokens: ToolTokens,
    pub total: u64,
    pub cost: f64,
    pub estimated: bool,
    #[serde(default)]
    pub tools: HashMap<String, ToolTokens>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaySummary {
    pub date: String,
    pub total: u64,
    pub cost: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PeriodData {
    pub today_key: String,
    pub today: ToolTokens,
    pub last7: ToolTokens,
    pub days: Vec<DaySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceInfo {
    pub key: String,
    pub label: String,
    pub root: String,
    pub hint: String,
    pub how: String,
    pub exists: bool,
    pub file_count: u64,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SourcesResult {
    pub tools: HashMap<String, SourceInfo>,
    pub total_files: u64,
    pub missing: u64,
    pub empty: u64,
    pub errors: u64,
    pub all_quiet: bool,
    pub banner: String,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub generated_at: i64,
    pub tools: HashMap<String, ToolStats>,
    pub grand: GrandTotal,
    pub by_day: HashMap<String, DayData>,
    pub period: PeriodData,
    pub sources: SourcesResult,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotOutput {
    pub snapshot: Snapshot,
    pub is_first: bool,
    pub has_delta: bool,
}

// ── 定价相关 ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PricingEntry {
    pub model: String,
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    pub cache_write: f64,
    #[serde(default)]
    pub cache_read: f64,
    #[serde(default)]
    pub free: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PricingTable {
    pub entries: Vec<PricingEntry>,
    pub default_input: f64,
    pub default_output: f64,
    pub default_cache_write: f64,
    pub default_cache_read: f64,
}

// ── 偏好设置 ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preferences {
    pub compact: bool,
    pub open_at_login: bool,
    pub version: String,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            compact: false,
            open_at_login: false,
            version: "1.5.8".to_string(),
        }
    }
}
