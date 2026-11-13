//! EIP-1559 ERC-20 transfer building. The registry hashes the transaction it built itself, so the
//! MPC never signs an opaque payload chosen by the relayer or the enclave.

use near_sdk::env;

/// `transfer(address,uint256)` selector.
const ERC20_TRANSFER_SELECTOR: [u8; 4] = [0xa9, 0x05, 0x9c, 0xbb];
const EIP1559_TX_TYPE: u8 = 0x02;

/// Fields of an unsigned type-2 ERC-20 transfer.
pub struct Erc20Transfer<'a> {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub token: &'a [u8; 20],
    pub to: &'a [u8; 20],
    pub amount: u128,
}

/// 0x02 || rlp([chain_id, nonce, max_priority_fee, max_fee, gas_limit, token, 0, data, []]).
pub fn unsigned_erc20_transfer(tx: &Erc20Transfer) -> Vec<u8> {
    let mut data = Vec::with_capacity(68);
    data.extend_from_slice(&ERC20_TRANSFER_SELECTOR);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(tx.to);
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&tx.amount.to_be_bytes());

    let mut items = Vec::new();
    rlp_uint(&mut items, u128::from(tx.chain_id));
    rlp_uint(&mut items, u128::from(tx.nonce));
    rlp_uint(&mut items, tx.max_priority_fee_per_gas);
    rlp_uint(&mut items, tx.max_fee_per_gas);
    rlp_uint(&mut items, u128::from(tx.gas_limit));
    rlp_bytes(&mut items, tx.token);
    rlp_uint(&mut items, 0);
    rlp_bytes(&mut items, &data);
    rlp_list_header(&mut items, 0); // empty access list
    let mut out = vec![EIP1559_TX_TYPE];
    rlp_list_header(&mut out, items.len());
    out.extend_from_slice(&items);
    out
}

/// EVM address of an uncompressed secp256k1 key (x || y): last 20 bytes of keccak256.
pub fn address_from_xy(xy: &[u8]) -> String {
    let hash = env::keccak256_array(xy);
    format!("0x{}", hex::encode(&hash[12..]))
}

/// Accepts `0x` + 40 hex digits in any case and returns the lowercase form.
pub fn normalize_address(value: &str) -> Option<String> {
    let digits = value.strip_prefix("0x")?;
    if digits.len() != 40 || !digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("0x{}", digits.to_ascii_lowercase()))
}

/// Bytes of an address already normalised by `normalize_address`.
pub fn address_bytes(value: &str) -> Option<[u8; 20]> {
    let digits = value.strip_prefix("0x")?;
    hex::decode(digits).ok()?.try_into().ok()
}

fn rlp_uint(out: &mut Vec<u8>, value: u128) {
    let bytes = value.to_be_bytes();
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    rlp_bytes(out, &bytes[first..]);
}

fn rlp_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        out.push(bytes[0]);
        return;
    }
    rlp_length(out, 0x80, bytes.len());
    out.extend_from_slice(bytes);
}

fn rlp_list_header(out: &mut Vec<u8>, payload_len: usize) {
    rlp_length(out, 0xc0, payload_len);
}

/// Short form for lengths up to 55, long form (offset + 55 + length-of-length) beyond.
fn rlp_length(out: &mut Vec<u8>, offset: u8, len: usize) {
    if len <= 55 {
        out.push(offset + len as u8);
        return;
    }
    let len_bytes = (len as u64).to_be_bytes();
    let first = len_bytes.iter().position(|b| *b != 0).unwrap_or(7);
    out.push(offset + 55 + (8 - first) as u8);
    out.extend_from_slice(&len_bytes[first..]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sepolia_example(nonce: u64, chain_id: u64, priority: u128) -> Vec<u8> {
        let token = address_bytes("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238").unwrap();
        let to = address_bytes("0xd8da6bf26964af9d7eed9e03e53415d37aa96045").unwrap();
        unsigned_erc20_transfer(&Erc20Transfer {
            chain_id,
            nonce,
            max_priority_fee_per_gas: priority,
            max_fee_per_gas: 30_000_000_000,
            gas_limit: 65_000,
            token: &token,
            to: &to,
            amount: 1_234_567_890_000_000_000,
        })
    }

    /// Expected bytes and hashes were produced independently with viem 2
    /// (`serializeTransaction` + `keccak256`) for the same fields.
    #[test]
    fn unsigned_transfer_matches_viem_byte_for_byte() {
        let tx = sepolia_example(7, 11_155_111, 1_500_000_000);
        assert_eq!(
            hex::encode(&tx),
            "02f87083aa36a7078459682f008506fc23ac0082fde8941c7d4b196cb0c7b01d743fbc6116a902379c723880b844a9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045000000000000000000000000000000000000000000000000112210f4768db400c0"
        );
        assert_eq!(
            hex::encode(env::keccak256_array(&tx)),
            "859c3bd8b8d8a23372d8cb8995654256d07893472c22e3b653c4d40cc6067d8f"
        );
    }

    #[test]
    fn zero_nonce_and_zero_tip_encode_as_empty_strings() {
        let tx = sepolia_example(0, 1, 0);
        assert_eq!(
            hex::encode(&tx),
            "02f8690180808506fc23ac0082fde8941c7d4b196cb0c7b01d743fbc6116a902379c723880b844a9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045000000000000000000000000000000000000000000000000112210f4768db400c0"
        );
        assert_eq!(
            hex::encode(env::keccak256_array(&tx)),
            "eec0add1639084ef5bc2a25fd49e66bb5253b810381d648235aa27c3c934494f"
        );
    }

    #[test]
    fn addresses_are_checked_and_lowercased() {
        assert_eq!(
            normalize_address("0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045").as_deref(),
            Some("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")
        );
        assert!(normalize_address("d8da6bf26964af9d7eed9e03e53415d37aa96045").is_none());
        assert!(normalize_address("0xd8da6bf26964af9d7eed9e03e53415d37aa9604").is_none());
        assert!(normalize_address("0xz8da6bf26964af9d7eed9e03e53415d37aa96045").is_none());
    }
}
