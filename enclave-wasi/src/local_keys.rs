//! Keys derived from a seed, standing in for OutLayer's keystore in tests and local runs. The
//! OutLayer build never compiles this in: its keys never leave the keystore.

use crate::enclave::Keys;
use crate::{RandomBytes, Result};
use chacha20poly1305::{aead::Aead, aead::Payload, ChaCha20Poly1305, KeyInit};
use ed25519_dalek::{Signer, SigningKey};
use hkdf::Hkdf;
use sha2::Sha256;

pub struct LocalKeys {
    signing: SigningKey,
    seal: [u8; 32],
    boxing: [u8; 32],
}

fn derive(seed: &[u8; 32], info: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, seed)
        .expand(info.as_bytes(), &mut out)
        .expect("32 bytes is a valid HKDF length");
    out
}

impl LocalKeys {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            signing: SigningKey::from_bytes(&derive(&seed, "glidepath/local/signing")),
            seal: derive(&seed, "glidepath/local/seal"),
            boxing: derive(&seed, "glidepath/local/box"),
        }
    }
}

impl Keys for LocalKeys {
    fn signing_public_key(&self) -> Result<[u8; 32]> {
        Ok(self.signing.verifying_key().to_bytes())
    }
    fn sign(&self, message: &[u8]) -> Result<[u8; 64]> {
        Ok(self.signing.sign(message).to_bytes())
    }
    fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        let mut nonce = [0u8; 12];
        crate::OsRandom.fill(&mut nonce);
        let ct = ChaCha20Poly1305::new(&self.seal.into())
            .encrypt(
                &nonce.into(),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| "seal failed")?;
        Ok([nonce.as_slice(), &ct].concat())
    }
    fn open(&self, ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.len() < 12 {
            return Err("decryption failed".into());
        }
        let (nonce, ct) = ciphertext.split_at(12);
        ChaCha20Poly1305::new(&self.seal.into())
            .decrypt(nonce.into(), Payload { msg: ct, aad })
            .map_err(|_| "decryption failed".into())
    }
    fn box_secret(&self) -> Result<[u8; 32]> {
        Ok(self.boxing)
    }
}
