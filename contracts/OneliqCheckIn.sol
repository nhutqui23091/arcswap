// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title OneliqCheckIn
 * @notice On-chain daily check-in + streak tracker for the Oneliq Portal on Arc Testnet.
 *
 * Each wallet calls `checkIn()` once per UTC day. The contract records the
 * streak, longest streak and lifetime total, and emits a {CheckedIn} event so
 * the activity is verifiable on-chain (testnet.arcscan.app) — no custody of
 * funds, no external dependencies. This is the on-chain proof that backs the
 * Portal's off-chain points: every check-in is a real Arc transaction.
 *
 * Arc Testnet: chainId 5042002, RPC https://rpc.testnet.arc.network
 * Gas is paid in native USDC.
 */
contract OneliqCheckIn {
    /// @dev Per-wallet check-in record. Packs into a single storage slot group.
    struct Record {
        uint64 lastDay;       // last UTC day index (timestamp / 1 days) the wallet checked in
        uint32 streak;        // current consecutive-day streak
        uint32 longestStreak; // best streak ever reached
        uint64 totalCheckIns; // lifetime number of check-ins
    }

    mapping(address => Record) private _records;

    /// @notice Total number of check-ins across all wallets (global counter).
    uint256 public totalCheckIns;

    /// @notice Number of distinct wallets that have ever checked in.
    uint256 public uniqueUsers;

    /// @notice Emitted on every successful check-in.
    event CheckedIn(
        address indexed user,
        uint256 indexed day,
        uint32 streak,
        uint32 longestStreak,
        uint64 userTotal
    );

    /// @notice Optional on-chain "GM" message tied to a check-in (matches the Portal's Say-GM task).
    event GM(address indexed user, uint256 indexed day, string message);

    error AlreadyCheckedInToday();

    /// @dev Current UTC day index. Each calendar day is one unit.
    function _today() private view returns (uint64) {
        return uint64(block.timestamp / 1 days);
    }

    /**
     * @notice Record today's check-in for `msg.sender`.
     * @dev Reverts if the wallet already checked in during the current UTC day.
     *      A check-in on the day immediately after the previous one extends the
     *      streak; any gap resets it to 1.
     */
    function checkIn() external returns (uint32 streak) {
        return _checkIn("");
    }

    /**
     * @notice Check in and attach a short GM message, emitted via {GM}.
     * @param message Free-text greeting (kept on-chain only in the event log, not storage).
     */
    function checkInWithGM(string calldata message) external returns (uint32 streak) {
        return _checkIn(message);
    }

    function _checkIn(string memory message) private returns (uint32) {
        uint64 day = _today();
        Record storage r = _records[msg.sender];

        if (r.totalCheckIns != 0 && r.lastDay == day) revert AlreadyCheckedInToday();

        if (r.totalCheckIns == 0) {
            uniqueUsers += 1;
            r.streak = 1;
        } else if (r.lastDay + 1 == day) {
            r.streak += 1;
        } else {
            r.streak = 1;
        }

        if (r.streak > r.longestStreak) r.longestStreak = r.streak;

        r.lastDay = day;
        r.totalCheckIns += 1;
        totalCheckIns += 1;

        emit CheckedIn(msg.sender, day, r.streak, r.longestStreak, r.totalCheckIns);
        if (bytes(message).length != 0) emit GM(msg.sender, day, message);

        return r.streak;
    }

    /// @notice Whether `user` is allowed to check in right now (hasn't checked in today).
    function canCheckIn(address user) external view returns (bool) {
        Record storage r = _records[user];
        return r.totalCheckIns == 0 || r.lastDay != _today();
    }

    /// @notice Full stats for `user`.
    function statsOf(address user)
        external
        view
        returns (uint64 lastDay, uint32 streak, uint32 longestStreak, uint64 userTotal)
    {
        Record storage r = _records[user];
        return (r.lastDay, r.streak, r.longestStreak, r.totalCheckIns);
    }
}
