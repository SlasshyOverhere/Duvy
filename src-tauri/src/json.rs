//! Small readers for untrusted JSON rows coming back from account APIs.

use serde_json::Value;

pub fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn int(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

/// An endpoint that documents an array sometimes answers with one row.
pub fn as_rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        Value::Null => Vec::new(),
        other => vec![other],
    }
}