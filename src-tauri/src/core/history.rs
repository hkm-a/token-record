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

const CODEX_CORRECTION_MARKER: &str = "history.migration-v1.6.6-codex";

fn history_path() -> PathBuf {
    crate::config::config_dir().join("history.json")
}

fn codex_correction_marker_path() -> PathBuf {
    crate::config::config_dir().join(CODEX_CORRECTION_MARKER)
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

/// 将受旧 Codex 重放计数错误影响、且源文件仍可见的日期直接改为本轮扫描结果。
/// 源文件已被清理的日期没有可验证的替代数据，保留旧值以避免凭空改写历史。
pub fn correct_codex_records(hist: &mut History, by_day: &HashMap<String, DayData>, now_ms: i64) -> bool {
    let mut corrected = false;

    for (date, day) in by_day {
        let Some(live) = day.tools.get("codex") else {
            continue;
        };
        let entry = hist.entry(date.clone()).or_default();
        if !same_stat(entry.tools.get("codex"), live) {
            entry.tools.insert("codex".to_string(), live.clone());
            entry.updated_at = now_ms;
            corrected = true;
        }
    }

    corrected
}

fn same_stat(existing: Option<&DayToolStat>, live: &DayToolStat) -> bool {
    existing.is_some_and(|kept| {
        kept.input == live.input
            && kept.output == live.output
            && kept.cache_write == live.cache_write
            && kept.cache_read == live.cache_read
            && kept.total == live.total
            && kept.cost == live.cost
            && kept.estimated == live.estimated
    })
}

fn backup_before_codex_correction() -> Result<(), String> {
    let source = history_path();
    if !source.exists() {
        return Ok(());
    }
    let backup = source.with_file_name("history.pre-v1.6.6.json");
    if !backup.exists() {
        std::fs::copy(&source, &backup).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn save_codex_correction_marker() -> Result<(), String> {
    let path = codex_correction_marker_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, "v1.6.6 Codex 历史校正已执行\n").map_err(|e| e.to_string())
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
            let correction_pending = !codex_correction_marker_path().exists();
            let (correction_allowed, correction_applied) = if correction_pending {
                match backup_before_codex_correction() {
                    Ok(()) => {
                        let corrected = correct_codex_records(&mut hist, &snapshot.by_day, snapshot.generated_at);
                        (true, corrected)
                    }
                    Err(e) => {
                        eprintln!("[token-record] Codex 历史备份失败，已跳过本轮校正: {}", e);
                        (false, false)
                    }
                }
            } else {
                (false, false)
            };
            merge(&mut hist, &snapshot.by_day, snapshot.generated_at);
            if let Err(e) = save(&hist) {
                eprintln!("[token-record] 历史写盘失败（本轮仅展示合并结果）: {}", e);
            } else if correction_pending && correction_allowed {
                if let Err(e) = save_codex_correction_marker() {
                    eprintln!("[token-record] Codex 历史校正标记写盘失败，下次将重试: {}", e);
                } else if correction_applied {
                    eprintln!("[token-record] 已校正当前可见日期的 Codex 历史，并保留 v1.6.6 前备份。");
                }
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
