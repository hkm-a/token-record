// CLI 校验工具：不启动 UI，直接打印四源聚合结果。
// 运行: cargo run --bin trcli
//       cargo run --bin trcli -- --csv export.csv

use std::path::PathBuf;
use std::collections::HashMap;
use token_record_lib::core::types::{Snapshot, DayData};
use token_record_lib::core::collectors;
use token_record_lib::core::sources;
use token_record_lib::core::aggregator;

fn fmt_num(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn money(n: f64) -> String {
    if n < 1.0 {
        format!("${:.4}", n)
    } else {
        format!("${:.2}", n)
    }
}

const TOOL_LABEL: &[(&str, &str)] = &[
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("pi", "Pi"),
    ("grok", "Grok Build"),
];

fn tool_label(key: &str) -> &str {
    for &(k, label) in TOOL_LABEL {
        if k == key {
            return label;
        }
    }
    key
}

fn print_snapshot(snapshot: &Snapshot) {
    let line = "─".repeat(56);

    println!("\n  Token 消耗与花费汇总");
    let ts = chrono::DateTime::from_timestamp_millis(snapshot.generated_at)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("  生成时间：{}", ts);
    println!("{}", line);

    let p = &snapshot.period;
    println!("  今日：{} tokens · {}", fmt_num(p.today.total), money(p.today_cost));
    println!("  近7日：{} tokens · {}", fmt_num(p.last7.total), money(p.last7_cost));

    if !p.days.is_empty() {
        let spark: Vec<String> = p.days.iter().map(|d| {
            let short = &d.date[5..];
            format!("{}:{}", short, fmt_num(d.total))
        }).collect();
        println!("  近7日序列：{}", spark.join("  "));
    }
    println!("{}", line);

    // 数据源状态
    let src = &snapshot.sources;
    println!("  数据源状态");
    for tool_info in src.tools.values() {
        let mark = match tool_info.status.as_str() {
            "ok" => "✓",
            "missing" => "✗",
            "empty" => "○",
            _ => "!",
        };
        println!("    {} {}: {}", mark, tool_info.label, tool_info.message);
        println!("      路径 {}", tool_info.root);
    }
    if !src.banner.is_empty() {
        println!("  提示：{}", src.banner);
    }
    println!("{}", line);

    let tool_names: Vec<&String> = snapshot.tools.keys().collect();
    if tool_names.is_empty() {
        println!("  暂无任何用量数据。");
        println!("  请先使用 Claude Code / Codex / Pi / Grok Build 产生本地会话后再刷新。");
    }

    for name in tool_names {
        let t = &snapshot.tools[name];
        let est_tag = if t.estimated { "  (含估算定价)" } else { "" };
        println!("\n  ■ {}{}", tool_label(name), est_tag);
        println!("    Token 合计 : {}", fmt_num(t.total));
        println!(
            "      输入 {} / 输出 {} / 缓存写 {} / 缓存读 {}",
            fmt_num(t.tokens.input),
            fmt_num(t.tokens.output),
            fmt_num(t.tokens.cache_write),
            fmt_num(t.tokens.cache_read),
        );
        println!("    花费       : {}", money(t.cost));
        println!("    今日       : {} tokens / {}", fmt_num(t.today.total), money(t.today.cost));
        println!("    会话数     : {}", t.session_count);
        for (m, mm) in &t.models {
            let tags = if mm.free { " (免费)" } else { "" };
            let est = if mm.estimated { " *估算" } else { "" };
            println!("      · {}: {} tokens, {}{}{}", m, fmt_num(mm.total), money(mm.cost), tags, est);
        }
    }

    let g = &snapshot.grand;
    let est_tag = if g.estimated { "  (含估算定价)" } else { "" };
    println!("\n{}", line);
    println!("  总计：{} tokens，{}{}", fmt_num(g.total), money(g.cost), est_tag);
    println!("  内置价目表：src-tauri/pricing.json");
    println!();
}

/// 将 byDay 导出为 CSV
fn export_csv(path: &PathBuf, by_day: &HashMap<String, DayData>) {
    let mut wtr = csv::Writer::from_path(path).unwrap_or_else(|e| {
        eprintln!("无法创建 CSV 文件 {}: {}", path.display(), e);
        std::process::exit(1);
    });

    // 收集所有工具名
    let mut tool_keys: Vec<&String> = by_day.values()
        .flat_map(|d| d.tools.keys())
        .collect();
    tool_keys.sort();
    tool_keys.dedup();

    // 写表头
    let mut header: Vec<String> = vec!["日期".to_string(), "total".to_string(), "cost".to_string()];
    for tk in &tool_keys {
        header.push(format!("{}-total", tk));
        header.push(format!("{}-input", tk));
        header.push(format!("{}-output", tk));
        header.push(format!("{}-cacheWrite", tk));
        header.push(format!("{}-cacheRead", tk));
        header.push(format!("{}-cost", tk));
    }
    wtr.write_record(&header).ok();

    // 排序日期
    let mut dates: Vec<&String> = by_day.keys().collect();
    dates.sort();

    for date in dates {
        let day = &by_day[date];
        let mut row = vec![
            date.clone(),
            day.total.to_string(),
            format!("{:.4}", day.cost),
        ];
        for tk in &tool_keys {
            if let Some(td) = day.tools.get(*tk) {
                row.push(td.total.to_string());
                row.push(td.input.to_string());
                row.push(td.output.to_string());
                row.push(td.cache_write.to_string());
                row.push(td.cache_read.to_string());
                row.push("0".to_string());
            } else {
                for _ in 0..6 {
                    row.push("0".to_string());
                }
            }
        }
        wtr.write_record(&row).ok();
    }
    wtr.flush().ok();
    println!("  已导出 CSV：{}", path.display());
}

fn parse_args() -> Option<PathBuf> {
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--csv" {
            let path = if i + 1 < args.len() {
                args[i + 1].clone()
            } else {
                ".cache/export.csv".to_string()
            };
            return Some(PathBuf::from(path));
        }
        if args[i].starts_with("--csv=") {
            return Some(PathBuf::from(&args[i][6..]));
        }
        i += 1;
    }
    None
}

fn main() {
    let csv_path = parse_args();

    // 采集
    let mut events = Vec::new();
    events.extend(collectors::collect_claude_events());
    events.extend(collectors::collect_codex_events());
    events.extend(collectors::collect_pi_events());
    events.extend(collectors::collect_grok_events());

    // 聚合
    let mut snapshot = aggregator::aggregate(&events);
    snapshot.sources = sources::probe_sources();

    // 输出
    print_snapshot(&snapshot);

    // CSV 导出
    if let Some(path) = csv_path {
        export_csv(&path, &snapshot.by_day);
    }
}
