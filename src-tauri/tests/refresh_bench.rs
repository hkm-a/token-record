// 回归测试：文件解析缓存的一致性与收益。
// 依赖本机真实会话目录：目录为空时冷/热耗时接近，一致性断言依然有效。
use std::time::Instant;

#[test]
fn refresh_cache_consistency() {
    let t0 = Instant::now();
    let a = token_record_lib::refresh();
    let cold = t0.elapsed();
    let t1 = Instant::now();
    let b = token_record_lib::refresh();
    let warm = t1.elapsed();
    println!("cold={:?} warm={:?}", cold, warm);
    assert_eq!(a.snapshot.grand.total, b.snapshot.grand.total, "缓存前后聚合结果必须一致");
    // 费用为浮点数按 HashMap 迭代序累加，顺序不定带来末位抖动，用容差比较
    let diff = (a.snapshot.grand.cost - b.snapshot.grand.cost).abs();
    assert!(diff < 1e-6, "缓存前后费用聚合必须一致（diff={}）", diff);
}
