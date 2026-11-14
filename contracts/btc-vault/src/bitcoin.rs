//! The Bitcoin encoding the vault needs, for testnet4 only: addresses (bech32, bech32m and
//! base58check), the unsigned transaction, and the BIP143 segwit v0 signature hash. The vault
//! builds every hash it asks the MPC network to sign from its own stored request.

use near_sdk::{bs58, env};

/// Bech32 human-readable part of Bitcoin testnet (and testnet4) addresses.
pub const HRP: &str = "tb";
const P2PKH_VERSION: u8 = 0x6f;
const P2SH_VERSION: u8 = 0xc4;
pub const TX_VERSION: u32 = 2;
/// Every input signals replace-by-fee (BIP125), so a guardian's claw-back can replace an executed
/// withdrawal that is still unconfirmed.
pub const SEQUENCE_RBF: u32 = 0xffff_fffd;
pub const SIGHASH_ALL: u32 = 1;
/// BIP173: an address is at most 90 characters.
const MAX_ADDRESS_LEN: usize = 90;
const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST: u32 = 1;
const BECH32M_CONST: u32 = 0x2bc8_30a3;

pub struct TxIn {
    /// Display order (as explorers print it); serialised reversed.
    pub txid: [u8; 32],
    pub vout: u32,
    pub amount: u64,
    pub sequence: u32,
}

pub struct TxOut {
    pub value: u64,
    pub script: Vec<u8>,
}

pub struct Tx {
    pub version: u32,
    pub inputs: Vec<TxIn>,
    pub outputs: Vec<TxOut>,
    pub locktime: u32,
}

pub fn double_sha256(data: &[u8]) -> [u8; 32] {
    env::sha256_array(env::sha256_array(data))
}

pub fn hash160(data: &[u8]) -> [u8; 20] {
    env::ripemd160_array(env::sha256_array(data))
}

pub fn p2wpkh_script(pubkey_hash: &[u8; 20]) -> Vec<u8> {
    [&[0x00, 0x14][..], pubkey_hash].concat()
}

/// The legacy-style script BIP143 signs for a P2WPKH input: OP_DUP OP_HASH160 <h> OP_EQUALVERIFY OP_CHECKSIG.
fn p2wpkh_script_code(pubkey_hash: &[u8; 20]) -> Vec<u8> {
    [&[0x19, 0x76, 0xa9, 0x14][..], pubkey_hash, &[0x88, 0xac]].concat()
}

/// The non-witness serialisation, whose double SHA-256 (reversed) is the txid.
pub fn serialize_unsigned(tx: &Tx) -> Vec<u8> {
    let mut out = Vec::with_capacity(10 + tx.inputs.len() * 41 + tx.outputs.len() * 43);
    out.extend_from_slice(&tx.version.to_le_bytes());
    write_varint(&mut out, tx.inputs.len() as u64);
    for input in &tx.inputs {
        write_outpoint(&mut out, input);
        out.push(0x00); // empty scriptSig: the signature goes in the witness
        out.extend_from_slice(&input.sequence.to_le_bytes());
    }
    write_varint(&mut out, tx.outputs.len() as u64);
    for output in &tx.outputs {
        write_output(&mut out, output);
    }
    out.extend_from_slice(&tx.locktime.to_le_bytes());
    out
}

/// BIP143's hashPrevouts: every input's outpoint, in order.
fn hash_prevouts(tx: &Tx) -> [u8; 32] {
    let mut prevouts = Vec::with_capacity(tx.inputs.len() * 36);
    for input in &tx.inputs {
        write_outpoint(&mut prevouts, input);
    }
    double_sha256(&prevouts)
}

/// BIP143's hashOutputs: every output, in order.
fn hash_outputs(tx: &Tx) -> [u8; 32] {
    let mut outputs = Vec::new();
    for output in &tx.outputs {
        write_output(&mut outputs, output);
    }
    double_sha256(&outputs)
}

/// sha256(hashPrevouts ‖ hashOutputs): BIP143 signatures can be combined only within one value.
pub fn binding_hash(tx: &Tx) -> [u8; 32] {
    env::sha256_array([hash_prevouts(tx), hash_outputs(tx)].concat())
}

/// BIP143 signature hash (SIGHASH_ALL) of input `index`, spent from the P2WPKH of `pubkey_hash`.
pub fn bip143_sighash(tx: &Tx, index: usize, pubkey_hash: &[u8; 20]) -> [u8; 32] {
    let mut sequences = Vec::with_capacity(tx.inputs.len() * 4);
    for input in &tx.inputs {
        sequences.extend_from_slice(&input.sequence.to_le_bytes());
    }
    let input = &tx.inputs[index];
    let mut preimage = Vec::with_capacity(182);
    preimage.extend_from_slice(&tx.version.to_le_bytes());
    preimage.extend_from_slice(&hash_prevouts(tx));
    preimage.extend_from_slice(&double_sha256(&sequences));
    write_outpoint(&mut preimage, input);
    preimage.extend_from_slice(&p2wpkh_script_code(pubkey_hash));
    preimage.extend_from_slice(&input.amount.to_le_bytes());
    preimage.extend_from_slice(&input.sequence.to_le_bytes());
    preimage.extend_from_slice(&hash_outputs(tx));
    preimage.extend_from_slice(&tx.locktime.to_le_bytes());
    preimage.extend_from_slice(&SIGHASH_ALL.to_le_bytes());
    double_sha256(&preimage)
}

/// Virtual size of the signed transaction when every input is P2WPKH, taking the longest (72-byte)
/// DER signature, so a fee rate checked against it is never overstated.
pub fn estimated_vsize(input_count: usize, outputs: &[TxOut]) -> u64 {
    // version + locktime + both counts (4 + 4 + 1 + 1 bytes), plus the segwit marker and flag (2 WU).
    let mut weight = 10 * 4 + 2;
    // outpoint + empty scriptSig + sequence (41 bytes), and a witness of 2 items: 72 + 33 bytes.
    weight += input_count as u64 * (41 * 4 + 108);
    for output in outputs {
        weight += (8 + 1 + output.script.len() as u64) * 4;
    }
    weight.div_ceil(4)
}

fn write_outpoint(out: &mut Vec<u8>, input: &TxIn) {
    out.extend(input.txid.iter().rev());
    out.extend_from_slice(&input.vout.to_le_bytes());
}

fn write_output(out: &mut Vec<u8>, output: &TxOut) {
    out.extend_from_slice(&output.value.to_le_bytes());
    write_varint(out, output.script.len() as u64);
    out.extend_from_slice(&output.script);
}

fn write_varint(out: &mut Vec<u8>, n: u64) {
    match n {
        0..=0xfc => out.push(n as u8),
        0xfd..=0xffff => {
            out.push(0xfd);
            out.extend_from_slice(&(n as u16).to_le_bytes());
        }
        _ => {
            out.push(0xfe);
            out.extend_from_slice(&(n as u32).to_le_bytes());
        }
    }
}

/// The P2WPKH address of a compressed public key, e.g. `tb1q…`.
pub fn p2wpkh_address(pubkey_hash: &[u8; 20]) -> String {
    segwit_address(0, pubkey_hash)
}

fn segwit_address(version: u8, program: &[u8]) -> String {
    let mut data = vec![version];
    data.extend(convert_bits(program, 8, 5, true).unwrap_or_default());
    let constant = if version == 0 {
        BECH32_CONST
    } else {
        BECH32M_CONST
    };
    let mut values = hrp_expand(HRP);
    values.extend_from_slice(&data);
    values.extend_from_slice(&[0; 6]);
    let checksum = polymod(&values) ^ constant;
    let mut out = format!("{HRP}1");
    for value in data {
        out.push(CHARSET[value as usize] as char);
    }
    for i in 0..6 {
        out.push(CHARSET[((checksum >> (5 * (5 - i))) & 31) as usize] as char);
    }
    out
}

/// The output script a testnet address pays to: P2WPKH, P2WSH, P2TR, P2PKH or P2SH. None for
/// anything else: mainnet addresses, and witness versions anyone could spend today.
pub fn script_for_address(address: &str) -> Option<Vec<u8>> {
    if address.is_empty() || address.len() > MAX_ADDRESS_LEN {
        return None;
    }
    let lower = address.to_ascii_lowercase();
    if lower.starts_with("tb1") {
        // BIP173 allows all-lowercase or all-uppercase, never mixed.
        if address != lower && address != address.to_ascii_uppercase() {
            return None;
        }
        return segwit_script(&lower);
    }
    base58_script(address)
}

fn segwit_script(address: &str) -> Option<Vec<u8>> {
    let (hrp, data) = address.rsplit_once('1')?;
    if hrp != HRP || data.len() < 7 {
        return None;
    }
    let values: Vec<u8> = data
        .bytes()
        .map(|c| CHARSET.iter().position(|x| *x == c).map(|p| p as u8))
        .collect::<Option<_>>()?;
    let version = values[0];
    if version > 16 {
        return None;
    }
    let mut check = hrp_expand(hrp);
    check.extend_from_slice(&values);
    let expected = if version == 0 {
        BECH32_CONST
    } else {
        BECH32M_CONST
    };
    if polymod(&check) != expected {
        return None;
    }
    let program = convert_bits(&values[1..values.len() - 6], 5, 8, false)?;
    if program.len() < 2 || program.len() > 40 {
        return None;
    }
    if version == 0 && program.len() != 20 && program.len() != 32 {
        return None;
    }
    // Versions 2-16, and version 1 with anything but a 32-byte (Taproot) program, have no meaning
    // yet: anyone can spend such an output today.
    if version > 1 || (version == 1 && program.len() != 32) {
        return None;
    }
    let opcode = if version == 0 { 0x00 } else { 0x50 + version };
    Some([&[opcode, program.len() as u8][..], &program].concat())
}

fn base58_script(address: &str) -> Option<Vec<u8>> {
    let bytes = bs58::decode(address).into_vec().ok()?;
    if bytes.len() != 25 || double_sha256(&bytes[..21])[..4] != bytes[21..] {
        return None;
    }
    let hash = &bytes[1..21];
    match bytes[0] {
        P2PKH_VERSION => Some([&[0x76, 0xa9, 0x14][..], hash, &[0x88, 0xac]].concat()),
        P2SH_VERSION => Some([&[0xa9, 0x14][..], hash, &[0x87]].concat()),
        _ => None,
    }
}

fn polymod(values: &[u8]) -> u32 {
    const GEN: [u32; 5] = [
        0x3b6a_57b2,
        0x2650_8e6d,
        0x1ea1_19fa,
        0x3d42_33dd,
        0x2a14_62b3,
    ];
    let mut chk: u32 = 1;
    for value in values {
        let top = chk >> 25;
        chk = ((chk & 0x01ff_ffff) << 5) ^ u32::from(*value);
        for (i, g) in GEN.iter().enumerate() {
            if (top >> i) & 1 == 1 {
                chk ^= g;
            }
        }
    }
    chk
}

fn hrp_expand(hrp: &str) -> Vec<u8> {
    let mut out: Vec<u8> = hrp.bytes().map(|b| b >> 5).collect();
    out.push(0);
    out.extend(hrp.bytes().map(|b| b & 31));
    out
}

fn convert_bits(data: &[u8], from: u32, to: u32, pad: bool) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let max = (1u32 << to) - 1;
    let mut out = Vec::with_capacity(data.len() * from as usize / to as usize + 1);
    for value in data {
        let value = u32::from(*value);
        if value >> from != 0 {
            return None;
        }
        acc = (acc << from) | value;
        bits += from;
        while bits >= to {
            bits -= to;
            out.push(((acc >> bits) & max) as u8);
        }
    }
    if pad {
        if bits > 0 {
            out.push(((acc << (to - bits)) & max) as u8);
        }
    } else if bits >= from || ((acc << (to - bits)) & max) != 0 {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, Value};

    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../res/btc-vault-vectors.json")).unwrap()
    }

    fn txid(display_hex: &str) -> [u8; 32] {
        hex::decode(display_hex).unwrap().try_into().unwrap()
    }

    fn tx_from(value: &Value) -> Tx {
        Tx {
            version: value["version"].as_u64().unwrap() as u32,
            locktime: value["locktime"].as_u64().unwrap() as u32,
            inputs: value["inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| TxIn {
                    txid: txid(i["txid"].as_str().unwrap()),
                    vout: i["vout"].as_u64().unwrap() as u32,
                    amount: i["amount"].as_str().unwrap().parse().unwrap(),
                    sequence: i["sequence"].as_u64().unwrap() as u32,
                })
                .collect(),
            outputs: value["outputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|o| TxOut {
                    value: o["value"].as_str().unwrap().parse().unwrap(),
                    script: hex::decode(o["script"].as_str().unwrap()).unwrap(),
                })
                .collect(),
        }
    }

    fn h20(value: &Value) -> [u8; 20] {
        hex::decode(value.as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap()
    }

    #[test]
    fn the_bip143_native_p2wpkh_example_hashes_to_the_published_sighash() {
        let v = &vectors()["bip143_native_p2wpkh"];
        let tx = tx_from(&v["tx"]);
        assert_eq!(hex::encode(serialize_unsigned(&tx)), v["unsigned_tx"]);
        let index = v["input_index"].as_u64().unwrap() as usize;
        let sighash = bip143_sighash(&tx, index, &h20(&v["pubkey_hash"]));
        assert_eq!(hex::encode(sighash), v["sighash"]);
    }

    #[test]
    fn the_vault_spend_vector_matches_the_typescript_builder() {
        let v = &vectors()["vault_spend"];
        let tx = tx_from(&v["tx"]);
        assert_eq!(hex::encode(serialize_unsigned(&tx)), v["unsigned_tx"]);
        let pubkey_hash = h20(&v["pubkey_hash"]);
        for (i, expected) in v["sighashes"].as_array().unwrap().iter().enumerate() {
            assert_eq!(&hex::encode(bip143_sighash(&tx, i, &pubkey_hash)), expected);
        }
        assert_eq!(
            estimated_vsize(tx.inputs.len(), &tx.outputs),
            v["estimated_vsize"].as_u64().unwrap()
        );
    }

    #[test]
    fn addresses_decode_to_the_published_scripts() {
        for case in vectors()["addresses"].as_array().unwrap() {
            let address = case["address"].as_str().unwrap();
            let script = script_for_address(address).map(hex::encode);
            assert_eq!(script.as_deref(), case["script"].as_str(), "{address}");
        }
    }

    #[test]
    fn a_p2wpkh_address_round_trips() {
        let v = &vectors()["vault_spend"];
        let pubkey = hex::decode(v["public_key"].as_str().unwrap()).unwrap();
        let hash = hash160(&pubkey);
        assert_eq!(hash, h20(&v["pubkey_hash"]));
        let address = p2wpkh_address(&hash);
        assert_eq!(address, v["address"].as_str().unwrap());
        assert_eq!(script_for_address(&address), Some(p2wpkh_script(&hash)));
    }

    #[test]
    fn witness_versions_anyone_could_spend_are_refused() {
        for (version, program) in [(2u8, vec![1u8; 32]), (16, vec![1; 2]), (1, vec![1; 20])] {
            let address = segwit_address(version, &program);
            assert!(script_for_address(&address).is_none(), "{address}");
        }
        assert!(script_for_address(&segwit_address(1, &[1; 32])).is_some());
    }

    #[test]
    fn malformed_and_mainnet_addresses_are_refused() {
        for bad in [
            "",
            "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy",
            "tb1Qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
            "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
            "mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8s",
            "tb1pw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
        ] {
            assert!(script_for_address(bad).is_none(), "{bad}");
        }
    }
}
