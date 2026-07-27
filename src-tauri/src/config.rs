use super::core::types::Preferences;
use std::path::PathBuf;

fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| {
        let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
        home.join(".config")
    });
    base.join("token-record")
}

fn prefs_path() -> PathBuf {
    config_dir().join("prefs.json")
}

pub fn load_prefs() -> Preferences {
    let path = prefs_path();
    if !path.exists() {
        return Preferences::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Preferences::default(),
    }
}

pub fn save_prefs(prefs: &Preferences) {
    let path = prefs_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(content) = serde_json::to_string_pretty(prefs) {
        let _ = std::fs::write(&path, content);
    }
}
