use super::types::*;
use super::pricing;
use std::collections::{HashMap, HashSet};

/// 聚合事件列表为 Snapshot
pub fn aggregate(events: &[TokenEvent]) -> Snapshot {
    let generated_at = chrono::Utc::now().timestamp_millis();
    let today_key = chrono::Local::now().format("%Y-%m-%d").to_string();

    let mut by_day: HashMap<String, DayData> = HashMap::new();
    let mut tools: HashMap<String, ToolStats> = HashMap::new();
    let mut grand = GrandTotal::default();
    let mut seen_dedupe = HashSet::new();
    let mut sessions: HashMap<String, HashSet<String>> = HashMap::new();

    for event in events {
        // 去重
        if !seen_dedupe.insert(event.dedupe_key.clone()) {
            continue;
        }

        // 按工具分组
        let tool_entry = tools.entry(event.tool.clone()).or_insert_with(|| ToolStats {
            tokens: ToolTokens::default(),
            total: 0,
            cost: 0.0,
            estimated: false,
            session_count: 0,
            models: HashMap::new(),
            today: TodayStats::default(),
        });

        add_to_tokens(&mut tool_entry.tokens, event);
        tool_entry.total = tool_entry.tokens.total();
        tool_entry.cost += event.cost;
        if event.estimated {
            tool_entry.estimated = true;
        }

        // 今日统计
        if event.day_key == today_key {
            add_to_tokens(&mut tool_entry.today.tokens, event);
            tool_entry.today.total = tool_entry.today.tokens.total();
            tool_entry.today.cost += event.cost;
            if event.estimated {
                tool_entry.today.estimated = true;
            }
        }

        // 按模型分组
        let model_entry = tool_entry
            .models
            .entry(event.model.clone())
            .or_insert_with(|| {
                let matched = pricing::match_model(&event.model);
                let is_est = !pricing::is_free(&matched);
                ModelStats {
                    tokens: ToolTokens::default(),
                    total: 0,
                    cost: 0.0,
                    estimated: is_est,
                    matched: matched.clone(),
                    free: pricing::is_free(&matched),
                }
            });

        add_to_tokens(&mut model_entry.tokens, event);
        model_entry.total = model_entry.tokens.total();
        model_entry.cost += event.cost;

        // 会话去重
        if !event.session_id.is_empty() {
            sessions
                .entry(event.tool.clone())
                .or_default()
                .insert(event.session_id.clone());
        }

        // 按天分组
        let day_entry = by_day.entry(event.day_key.clone()).or_insert_with(|| DayData {
            tokens: ToolTokens::default(),
            total: 0,
            cost: 0.0,
            estimated: false,
            tools: HashMap::new(),
        });

        add_to_tokens(&mut day_entry.tokens, event);
        day_entry.total = day_entry.tokens.total();
        day_entry.cost += event.cost;
        if event.estimated {
            day_entry.estimated = true;
        }

        // 按天的工具子分组
        let day_tool = day_entry
            .tools
            .entry(event.tool.clone())
            .or_insert_with(ToolTokens::default);
        add_to_tokens(day_tool, event);

        // Grand total
        add_to_tokens(&mut grand.tokens, event);
        grand.total = grand.tokens.total();
        grand.cost += event.cost;
        if event.estimated {
            grand.estimated = true;
        }
    }

    // 填充 session_count
    for (tool, session_set) in &sessions {
        if let Some(ts) = tools.get_mut(tool) {
            ts.session_count = session_set.len() as u64;
        }
    }

    // 计算 period
    let period = build_period(&by_day, &today_key);

    // 来源状态
    let sources = SourcesResult::default();

    Snapshot {
        generated_at,
        tools,
        grand,
        by_day,
        period,
        sources,
    }
}

fn add_to_tokens(tokens: &mut ToolTokens, event: &TokenEvent) {
    tokens.input += event.input;
    tokens.output += event.output;
    tokens.cache_write += event.cache_write;
    tokens.cache_read += event.cache_read;
    tokens.total = tokens.total();
}

impl ToolTokens {
    fn total(&self) -> u64 {
        self.input + self.output + self.cache_write + self.cache_read
    }
}

/// 构建周期统计
fn build_period(
    by_day: &HashMap<String, DayData>,
    today_key: &str,
) -> PeriodData {
    let mut last7_tokens = ToolTokens::default();
    let mut last7_cost = 0.0;
    // 生成最近 7 天的键
    let today = chrono::Local::now().date_naive();
    let mut days = Vec::new();

    for i in (0..7).rev() {
        let d = today - chrono::Duration::days(i);
        let key = d.format("%Y-%m-%d").to_string();
        if let Some(day_data) = by_day.get(&key) {
            add_tokens_to_tool(&mut last7_tokens, day_data);
            last7_cost += day_data.cost;
            days.push(DaySummary {
                date: key.clone(),
                total: day_data.total,
                cost: day_data.cost,
            });
        } else {
            days.push(DaySummary {
                date: key,
                total: 0,
                cost: 0.0,
            });
        }
    }

    // 今日
    let default_day = DayData::default();
    let today_data = by_day.get(today_key).unwrap_or(&default_day);
    let today_tokens = ToolTokens {
        input: today_data.tokens.input,
        output: today_data.tokens.output,
        cache_write: today_data.tokens.cache_write,
        cache_read: today_data.tokens.cache_read,
        total: today_data.total,
    };

    PeriodData {
        today_key: today_key.to_string(),
        today: today_tokens,
        today_cost: today_data.cost,
        last7: last7_tokens,
        last7_cost,
        days,
    }
}

fn add_tokens_to_tool(target: &mut ToolTokens, source: &DayData) {
    target.input += source.tokens.input;
    target.output += source.tokens.output;
    target.cache_write += source.tokens.cache_write;
    target.cache_read += source.tokens.cache_read;
    target.total = target.total();
}
