// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A plain ERC-20 whose constructor mints every launch allocation, so a team allocation can be
/// created directly at a plan's Chain Signatures address and never touch an insider's key.
contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(
        string memory name_,
        string memory symbol_,
        address[] memory holders,
        uint256[] memory amounts
    ) {
        require(holders.length == amounts.length, "length mismatch");
        name = name_;
        symbol = symbol_;
        for (uint256 i = 0; i < holders.length; i++) {
            balanceOf[holders[i]] += amounts[i];
            totalSupply += amounts[i];
            emit Transfer(address(0), holders[i], amounts[i]);
        }
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) private {
        require(to != address(0), "zero address");
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
