//! Credential storage.
//!
//! Secrets live in the OS protected store (Windows Credential Manager, macOS
//! Keychain, Linux Secret Service) through `keyring`. SQLite only ever holds a
//! `keyring:1` marker, never the value. When the store is missing or refuses a
//! write the call fails: nothing is ever written in the clear.
//!
//! Rows written by older builds (`enc1:<hex>`, DPAPI on Windows) are read only
//! to migrate them into the protected store.

use std::fmt;

const MARKER: &str = "keyring:1";
const LEGACY_PREFIX: &str = "enc1:";

#[derive(Debug)]
pub enum SecretError {
    /// Nothing stored under this key.
    Absent,
    /// Stored, but it could not be turned back into text.
    Decode(String),
    /// The protected store is unavailable or refused the write.
    Store(String),
    /// The settings row itself could not be read or written.
    Db(String),
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Absent => write!(f, "no stored value"),
            Self::Decode(detail) => write!(f, "the stored value could not be decoded: {detail}"),
            Self::Store(detail) => write!(
                f,
                "the system credential store is unavailable, so nothing was saved: {detail}"
            ),
            Self::Db(detail) => write!(f, "{detail}"),
        }
    }
}

impl std::error::Error for SecretError {}

impl From<rusqlite::Error> for SecretError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Db(error.to_string())
    }
}

pub fn marker() -> &'static str {
    MARKER
}

pub fn is_protected(stored: &str) -> bool {
    stored == MARKER
}

pub fn is_legacy(stored: &str) -> bool {
    stored.starts_with(LEGACY_PREFIX)
}

pub fn store(key: &str, plain: &str) -> Result<(), SecretError> {
    backend::save(key, plain)
}

pub fn load(key: &str) -> Result<String, SecretError> {
    backend::load(key)
}

pub fn remove(key: &str) -> Result<(), SecretError> {
    backend::remove(key)
}

/// Migration only: reads a row written before the keyring existed.
pub fn decode_legacy(stored: &str) -> Result<String, SecretError> {
    let hex = stored.strip_prefix(LEGACY_PREFIX).unwrap_or(stored);
    let bytes = legacy_unseal(from_hex(hex)?)?;
    String::from_utf8(bytes).map_err(|_| SecretError::Decode("legacy value is not text".into()))
}

#[cfg(test)]
fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((byte & 0xf) as u32, 16).unwrap_or('0'));
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, SecretError> {
    let digits = text.as_bytes();
    if !digits.len().is_multiple_of(2) {
        return Err(SecretError::Decode("odd hex length".into()));
    }
    digits
        .chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char)
                .to_digit(16)
                .ok_or_else(|| SecretError::Decode("bad hex digit".into()))?;
            let lo = (pair[1] as char)
                .to_digit(16)
                .ok_or_else(|| SecretError::Decode("bad hex digit".into()))?;
            Ok((hi * 16 + lo) as u8)
        })
        .collect()
}

#[cfg(not(test))]
mod backend {
    use super::SecretError;
    use keyring::Entry;

    const SERVICE: &str = "duvy";

    fn entry(key: &str) -> Result<Entry, SecretError> {
        Entry::new(SERVICE, key).map_err(|error| SecretError::Store(error.to_string()))
    }

    pub fn save(key: &str, value: &str) -> Result<(), SecretError> {
        entry(key)?
            .set_password(value)
            .map_err(|error| SecretError::Store(error.to_string()))
    }

    pub fn load(key: &str) -> Result<String, SecretError> {
        match entry(key)?.get_password() {
            Ok(value) => Ok(value),
            Err(keyring::Error::NoEntry) => Err(SecretError::Absent),
            Err(error) => Err(SecretError::Decode(error.to_string())),
        }
    }

    pub fn remove(key: &str) -> Result<(), SecretError> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(SecretError::Store(error.to_string())),
        }
    }
}

// Tests must not touch the machine's credential store.
#[cfg(test)]
mod backend {
    use super::SecretError;
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        static STORE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    }

    pub fn save(key: &str, value: &str) -> Result<(), SecretError> {
        if key == "unavailable" {
            return Err(SecretError::Store("store is not running".into()));
        }
        STORE.with(|store| store.borrow_mut().insert(key.into(), value.into()));
        Ok(())
    }

    pub fn load(key: &str) -> Result<String, SecretError> {
        STORE
            .with(|store| store.borrow().get(key).cloned())
            .ok_or(SecretError::Absent)
    }

    pub fn remove(key: &str) -> Result<(), SecretError> {
        STORE.with(|store| store.borrow_mut().remove(key));
        Ok(())
    }
}

/// Copies the C buffer out and frees it. DPAPI leaves `pbData` null when it
/// returns an empty blob, and `from_raw_parts` on a null pointer is UB.
#[cfg(windows)]
fn take_blob(output: windows_sys::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows_sys::Win32::Foundation::{HLOCAL, LocalFree};

    if output.pbData.is_null() {
        return Vec::new();
    }
    unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as HLOCAL);
        bytes
    }
}

#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, SecretError> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // Legacy blobs were sealed without entropy; adding it would fail every one.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err(SecretError::Decode(format!(
            "DPAPI failed ({})",
            unsafe { GetLastError() }
        )));
    }
    Ok(take_blob(output))
}

#[cfg(windows)]
fn legacy_unseal(data: Vec<u8>) -> Result<Vec<u8>, SecretError> {
    dpapi(&data, false)
}

#[cfg(not(windows))]
fn legacy_unseal(data: Vec<u8>) -> Result<Vec<u8>, SecretError> {
    Ok(data)
}

#[cfg(all(windows, test))]
fn legacy_seal(data: &[u8]) -> Result<Vec<u8>, SecretError> {
    dpapi(data, true)
}

/// Test only: builds the `enc1:` payload an older build would have written.
#[cfg(test)]
pub(crate) fn legacy_payload(plain: &str) -> String {
    #[cfg(windows)]
    let bytes = legacy_seal(plain.as_bytes()).expect("seal");
    #[cfg(not(windows))]
    let bytes = plain.as_bytes().to_vec();
    format!("{LEGACY_PREFIX}{}", to_hex(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_round_trips_and_is_removable() {
        store("test:debrid", "rd-key-abc123").expect("store");
        assert_eq!(load("test:debrid").unwrap(), "rd-key-abc123");
        remove("test:debrid").expect("remove");
        assert!(matches!(load("test:debrid"), Err(SecretError::Absent)));
    }

    #[test]
    fn a_missing_entry_is_absent_and_a_bad_legacy_row_is_an_error() {
        assert!(matches!(load("test:never-written"), Err(SecretError::Absent)));
        assert!(matches!(
            decode_legacy("enc1:zz"),
            Err(SecretError::Decode(_))
        ));
    }

    #[test]
    fn a_store_failure_is_reported_instead_of_writing_plaintext() {
        let error = store("unavailable", "tok").unwrap_err();
        assert!(matches!(error, SecretError::Store(_)));
    }

    #[cfg(not(windows))]
    #[test]
    fn a_legacy_hex_value_still_decodes() {
        let legacy = legacy_payload("{\"key\":\"old\"}");
        assert_eq!(decode_legacy(&legacy).unwrap(), "{\"key\":\"old\"}");
    }

    #[cfg(windows)]
    #[test]
    fn a_legacy_dpapi_value_still_decodes() {
        let legacy = legacy_payload("{\"key\":\"old\"}");
        assert_eq!(decode_legacy(&legacy).unwrap(), "{\"key\":\"old\"}");
    }
}
