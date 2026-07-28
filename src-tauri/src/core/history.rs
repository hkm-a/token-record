use super::aggregator;
use super::types::{DayData, DayToolStat, GrandTotal, HistoryDay, Snapshot, TodayStats, ToolStats, ToolTokens};
use std::collections::HashMap;
use std::path::PathBuf;

/// 按日历史持久化。
///
/// 动机：各工具会自动清理本地旧会话文件（如 Claude Code 默认约 30 天），
/// 仅凭磁盘扫描，"总量"会随源清理不断缩水成近期量。
/// 本模块把每次扫描结果按 (日期, 工具) 合并进 history.json：
/// - 磁盘可见的天：正常情况下只增不减，以磁盘为准覆盖；
///   若磁盘值小于已记录值（源被部分清理），保留较大的已记录值，防止缩水；
/// - 磁盘不可见的天（已被源清理）：永久保留历史记录。
/// 合并后总量、各工具卡片、今日/近 7 日全部从历史重建，实现终身累计。
///
/// 已知边界：模型分布与会话数仍来自当前磁盘扫描（历史不保留该粒度）。

pub type History = HashMap<String, HistoryDay>;

fn history_path() -> PathBuf {
    crate::config::config_dir().join("history.json")
}

/// 读取历史。文件缺失视为空历史；文件存在但损坏返回 Err——
/// 调用方必须跳过本轮写盘，避免用空数据覆盖掉终身累计。
fn load() -> Result<History, String> {
    let path = history_path();
    if !path.exists() {
        return Ok(History::new());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

/// 原子写盘：先写临时文件再改名，避免中途崩溃留下半个 JSON。
fn save(hist: &History) -> Result<(), String> {
    let path = history_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string(hist).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 合并当前扫描的 byDay 到历史。
/// 对每个 (日期, 工具)：磁盘 total >= 已记录 total 时以磁盘为准覆盖，
/// 否则保留已记录值；历史独有的天与工具原样保留。
pub fn merge(hist: &mut History, by_day: &HashMap<String, DayData>, now_ms: i64) {
    for (date, day) in by_day {
        let entry = hist.entry(date.clone()).or_default();
        for (tool, live) in &day.tools {
            match entry.tools.get(tool) {
                Some(kept) if kept.total > live.total => {} // 源被部分清理，保留较大值
                _ => {
                    entry.tools.insert(tool.clone(), live.clone());
                }
            }
        }
        entry.updated_at = now_ms;
    }
}

/// 用合并后的历史重建快照的 byDay / tools / grand / period。
/// models 与 session_count 保留自当前磁盘扫描。
fn rebuild(snapshot: &mut Snapshot, hist: &History) {
    let mut by_day: HashMap<String, DayData> = HashMap::new();
    let mut tools: HashMap<String, ToolStats> = HashMap::new();
    let mut grand = GrandTotal::default();

    for (date, hday) in hist {
        let day_entry = by_day.entry(date.clone()).or_default();
        for (tool, stat) in &hday.tools {
            add_stat(&mut day_entry.tokens, stat);
            day_entry.total = day_entry.tokens.total;
            day_entry.cost += stat.cost;
            day_entry.estimated |= stat.estimated;
            day_entry.tools.insert(tool.clone(), stat.clone());

            let t = tools.entry(tool.clone()).or_insert_with(|| ToolStats {
                tokens: ToolTokens::default(),
                total: 0,
                cost: 0.0,
                estimated: false,
                session_count: 0,
                models: HashMap::new(),
                today: TodayStats::default(),
            });
            add_stat(&mut t.tokens, stat);
            t.total = t.tokens.total;
            t.cost += stat.cost;
            t.estimated |= stat.estimated;

            grand.cost += stat.cost;
            grand.estimated |= stat.estimated;
            add_stat(&mut grand.tokens, stat);
            grand.total = grand.tokens.total;
        }
    }

    // 今日统计从合并后的当日记录取
    let today_key = chrono::Local::now().format("%Y-%m-%d").to_string();
    if let Some(today) = by_day.get(&today_key) {
        for (tool, stat) in &today.tools {
            if let Some(t) = tools.get_mut(tool) {
                add_stat(&mut t.today.tokens, stat);
                t.today.total = t.today.tokens.total;
                t.today.cost += stat.cost;
                t.today.estimated |= stat.estimated;
            }
        }
    }

    // 模型分布与会话数无法从历史恢复，沿用当前磁盘扫描结果
    for (tool, live) in &snapshot.tools {
        if let Some(t) = tools.get_mut(tool) {
            t.models = live.models.clone();
            t.session_count = live.session_count;
        }
    }

    snapshot.period = aggregator::build_period(&by_day, &today_key);
    snapshot.by_day = by_day;
    snapshot.tools = tools;
    snapshot.grand = grand;
}

fn add_stat(target: &mut ToolTokens, stat: &DayToolStat) {
    target.input += stat.input;
    target.output += stat.output;
    target.cache_write += stat.cache_write;
    target.cache_read += stat.cache_read;
    target.total = target.input + target.output + target.cache_write + target.cache_read;
}

/// 入口：加载 → 合并 → 写盘 → 重建快照。
/// 历史文件损坏时保留原文件不覆盖，本轮退化为仅磁盘数据并在 stderr 记录。
pub fn apply(snapshot: &mut Snapshot) {
    match load() {
        Ok(mut hist) => {
            merge(&mut hist, &snapshot.by_day, snapshot.generated_at);
            if let Err(e) = save(&hist) {
                eprintln!("[token-record] 历史写盘失败（本轮仅展示合并结果）: {}", e);
            }
            rebuild(snapshot, &hist);
        }
        Err(e) => {
            eprintln!(
                "[token-record] 历史文件损坏，已跳过合并与写盘（文件保留待排查）: {}",
                e
            );
        }
    }
}
