use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// 逐行读取 JSONL 文件，返回每行解析出的 JSON Value。
/// 空行和解析失败的行会被静默跳过。
pub fn read_jsonl(path: &Path) -> Vec<serde_json::Value> {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let mut results = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => continue,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
            results.push(val);
        }
    }
    results
}
