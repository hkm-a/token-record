use super::types::PricingEntry;
use std::collections::HashMap;
use std::sync::OnceLock;

/// 编译时嵌入 pricing.json
const PRICING_JSON: &str = include_str!("../../pricing.json");

struct Pricing {
    entries: HashMap<String, PricingEntry>,
    default_entry: PricingEntry,
}

static PRICING: OnceLock<Pricing> = OnceLock::new();

fn get_pricing() -> &'static Pricing {
    PRICING.get_or_init(|| {
        let val: serde_json::Value = match serde_json::from_str(PRICING_JSON) {
            Ok(v) => v,
            Err(_) => return Pricing {
                entries: HashMap::new(),
                default_entry: PricingEntry {
                    model: "default".to_string(),
                    input: 15.0,
                    output: 75.0,
                    cache_write: 15.0,
                    cache_read: 7.5,
                    free: false,
                },
            },
        };
        let models = val.get("models").and_then(|m| m.as_object());
        let mut entries = HashMap::new();
        if let Some(models) = models {
            for (key, entry) in models {
                let e = match entry.as_object() {
                    Some(e) => e,
                    None => continue,
                };
                entries.insert(
                    key.clone(),
                    PricingEntry {
                        model: key.clone(),
                        input: e.get("input").and_then(|v| v.as_f64()).unwrap_or(15.0),
                        output: e.get("output").and_then(|v| v.as_f64()).unwrap_or(75.0),
                        cache_write: e.get("cacheWrite").and_then(|v| v.as_f64()).unwrap_or(15.0),
                        cache_read: e.get("cacheRead").and_then(|v| v.as_f64()).unwrap_or(7.5),
                        free: e.get("free").and_then(|v| v.as_bool()).unwrap_or(false),
                    },
                );
            }
        }
        let default_entry = val.get("default").and_then(|d| d.as_object()).map(|d| PricingEntry {
            model: "default".to_string(),
            input: d.get("input").and_then(|v| v.as_f64()).unwrap_or(15.0),
            output: d.get("output").and_then(|v| v.as_f64()).unwrap_or(75.0),
            cache_write: d.get("cacheWrite").and_then(|v| v.as_f64()).unwrap_or(15.0),
            cache_read: d.get("cacheRead").and_then(|v| v.as_f64()).unwrap_or(7.5),
            free: false,
        }).unwrap_or(PricingEntry {
            model: "default".to_string(),
            input: 15.0,
            output: 75.0,
            cache_write: 15.0,
            cache_read: 7.5,
            free: false,
        });
        Pricing { entries, default_entry }
    })
}

/// 根据最长子串匹配模型名称
pub fn match_model(model_name: &str) -> String {
    let pricing = get_pricing();
    let mut best_len = 0;
    let mut best = "default";

    for key in pricing.entries.keys() {
        if model_name.contains(key.as_str()) && key.len() > best_len {
            best_len = key.len();
            best = key;
        }
    }
    best.to_string()
}

/// 获取定价条目（基于 match_model 的最长子串匹配结果）
fn get_entry(model_name: &str) -> &PricingEntry {
    let pricing = get_pricing();
    let matched = match_model(model_name);
    if matched != "default" {
        if let Some(entry) = pricing.entries.get(&matched) {
            return entry;
        }
    }
    &pricing.default_entry
}

/// 判断是否免费
pub fn is_free(model_name: &str) -> bool {
    get_entry(model_name).free
}

/// 计算费用
pub fn calc_cost(
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
    model_name: &str,
) -> f64 {
    let entry = get_entry(model_name);
    if entry.free {
        return 0.0;
    }
    (input as f64 / 1_000_000.0) * entry.input
        + (output as f64 / 1_000_000.0) * entry.output
        + (cache_write as f64 / 1_000_000.0) * entry.cache_write
        + (cache_read as f64 / 1_000_000.0) * entry.cache_read
}
