// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/interfaces/IERC20.sol";

contract AdversarialUSDC is IERC20 {
    uint8 public constant NORMAL = 0;
    uint8 public constant FALSE_RETURN = 1;
    uint8 public constant NON_EXACT = 2;
    uint8 public constant REENTER = 3;
    uint8 public constant MALFORMED_RETURN = 4;
    uint8 public constant REVERT_CALL = 5;

    uint8 public override decimals = 6;
    uint8 public mode;
    uint256 public override totalSupply;
    address public reentryTarget;
    bytes public reentryData;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;

    function configure(uint8 mode_, address target_, bytes calldata data_) external {
        mode = mode_;
        reentryTarget = target_;
        reentryData = data_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _act(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        return _act(from, to, amount);
    }

    function _act(address from, address to, uint256 amount) private returns (bool) {
        if (mode == REVERT_CALL) revert("token rejected call");
        if (mode == FALSE_RETURN) return false;
        if (mode == MALFORMED_RETURN) {
            assembly {
                mstore(0, 1)
                return(0, 1)
            }
        }
        if (mode == REENTER) {
            (bool ok,) = reentryTarget.call(reentryData);
            require(!ok, "nested state change succeeded");
        }
        uint256 moved = mode == NON_EXACT ? amount - 1 : amount;
        require(balanceOf[from] >= moved, "balance");
        balanceOf[from] -= moved;
        balanceOf[to] += moved;
        return true;
    }
}
