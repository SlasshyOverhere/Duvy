//! Small readers for untrusted JSON rows coming back from account APIs.

use serde_json::Value;

pub fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Whole numbers only: a fractional or out-of-range value is not a timestamp,
/// and rounding it would put the row at an arbitrary point in time.
pub fn int(value: &Value, key: &str) -> i64 {
    let Some(Value::Number(number)) = value.get(key) else {
        return 0;
    };
    number
        .as_i64()
        .or_else(|| number.as_u64().and_then(|n| i64::try_from(n).ok()))
        .unwrap_or(0)
}

/// An endpoint that documents an array sometimes answers with one row. Anything
/// that is neither is an error body, which must not be read as a row.
pub fn as_rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        row @ Value::Object(_) => vec![row],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_whole_numbers_are_read_as_integers() {
        assert_eq!(int(&json!({ "at": 1_700_000_000 }), "at"), 1_700_000_000);
        assert_eq!(int(&json!({ "at": "17" }), "at"), 0);
        assert_eq!(int(&json!({ "at": 1.5 }), "at"), 0);
        assert_eq!(int(&json!({ "at": 1e300 }), "at"), 0);
        assert_eq!(int(&json!({ "at": -3 }), "at"), -3);
        assert_eq!(int(&json!({}), "at"), 0);
    }

    #[test]
    fn an_error_body_is_not_a_row() {
        assert_eq!(as_rows(json!([{ "a": 1 }])).len(), 1);
        assert_eq!(as_rows(json!({ "a": 1 })).len(), 1);
        assert!(as_rows(Value::Null).is_empty());
        assert!(as_rows(json!("rate limited")).is_empty());
        assert!(as_rows(json!(429)).is_empty());
    }
}
