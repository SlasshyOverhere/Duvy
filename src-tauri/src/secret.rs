//! DPAPI protection for stored credentials.
//!
//! Values are written as `enc1:<hex>`; anything without the prefix is a legacy
//! plaintext row and passes through untouched.

use crate::playback_log;

const PREFIX: &str = "enc1:";

/// Encrypts with the current Windows user's DPAPI key. A failure falls back to
/// plaintext so a write is never lost, but it is written into the journal: a
/// credential on disk in the clear is something the field should see.
pub fn encode(plain: &str) -> String {
    match protect(plain.as_bytes()) {
        Ok(cipher) => format!("{PREFIX}{}", to_hex(&cipher)),
        Err(error) => {
            eprintln!("[secret] encryption failed, storing plaintext: {error}");
            playback_log::mark(format!("secret: stored plaintext, DPAPI failed: {error}"));
            plain.to_string()
        }
    }
}

/// Inverse of [`encode`]. Returns legacy plaintext unchanged.
pub fn decode(stored: &str) -> Option<String> {
    let Some(hex) = stored.strip_prefix(PREFIX) else {
        return Some(stored.to_string());
    };
    let decrypted = from_hex(hex).and_then(|bytes| unprotect(&bytes));
    match decrypted.and_then(|bytes| String::from_utf8(bytes).map_err(|e| e.to_string())) {
        Ok(text) => Some(text),
        Err(error) => {
            eprintln!("[secret] decryption failed: {error}");
            playback_log::mark(format!("secret: DPAPI decrypt failed: {error}"));
            None
        }
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((byte & 0xf) as u32, 16).unwrap_or('0'));
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    let digits = text.as_bytes();
    if !digits.len().is_multiple_of(2) {
        return Err("odd hex length".into());
    }
    digits
        .chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16).ok_or("bad hex digit")?;
            let lo = (pair[1] as char).to_digit(16).ok_or("bad hex digit")?;
            Ok((hi * 16 + lo) as u8)
        })
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|e: &str| e.to_string())
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
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptProtectData failed ({})", unsafe {
            GetLastError()
        }));
    }
    let bytes = take_blob(output);
    Ok(bytes)
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("CryptUnprotectData failed ({})", unsafe {
            GetLastError()
        }));
    }
    let bytes = take_blob(output);
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}
