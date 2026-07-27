use token_record_lib;
use std::fs;

#[test]
fn test_snapshot_json_camel_case() {
    // First refresh (isFirst = true, delta empty)
    let out = token_record_lib::refresh();
    let json = serde_json::to_string_pretty(&out).unwrap();
    fs::write("snapshot_output.json", &json).unwrap();
    
    assert!(json.contains("generatedAt"), "missing generatedAt");
    assert!(json.contains("byDay"), "missing byDay");
    assert!(json.contains("todayKey"), "missing todayKey");
    assert!(json.contains("todayCost"), "missing todayCost");
    assert!(json.contains("cacheWrite"), "missing cacheWrite");
    assert!(json.contains("isFirst"), "missing isFirst");
    assert!(json.contains("grandTokenDelta"), "missing grandTokenDelta");
    assert!(!json.contains("generated_at"), "snake_case leaked");
    assert!(!json.contains("is_first"), "snake_case leaked");
    
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    let grand = &v["snapshot"]["grand"];
    assert!(grand["total"].as_u64().unwrap_or(0) > 0, "grand.total is 0");
    assert!(grand["cost"].as_f64().unwrap_or(0.0) > 0.0, "grand.cost is 0");
    
    // Second refresh (isFirst = false, delta may have values)
    let out2 = token_record_lib::refresh();
    let json2 = serde_json::to_string(&out2).unwrap();
    assert!(json2.contains("isFirst"), "missing isFirst in 2nd");
    // delta.tools may be empty if no change, but grandTokenDelta should exist
    assert!(json2.contains("grandTokenDelta"), "missing grandTokenDelta in 2nd");
}
