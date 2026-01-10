/**
 * Rate Limit Management
 *
 * Handles rate limit tracking and state management for accounts.
 * All rate limits are model-specific.
 * Includes soft limit support to prefer other accounts before quota exhaustion.
 */

import { DEFAULT_COOLDOWN_MS, SOFT_LIMIT_THRESHOLD } from '../constants.js';
import { formatDuration } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/**
 * Check if all accounts are rate-limited for a specific model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check rate limits for
 * @returns {boolean} True if all accounts are rate-limited
 */
export function isAllRateLimited(accounts, modelId) {
    if (accounts.length === 0) return true;
    if (!modelId) return false; // No model specified = not rate limited

    return accounts.every(acc => {
        if (acc.isInvalid) return true; // Invalid accounts count as unavailable
        const modelLimits = acc.modelRateLimits || {};
        const limit = modelLimits[modelId];
        return limit && limit.isRateLimited && limit.resetTime > Date.now();
    });
}

/**
 * Get list of available (non-rate-limited, non-invalid) accounts for a model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} [modelId] - Model ID to filter by
 * @returns {Array} Array of available account objects
 */
export function getAvailableAccounts(accounts, modelId = null) {
    return accounts.filter(acc => {
        if (acc.isInvalid) return false;

        if (modelId && acc.modelRateLimits && acc.modelRateLimits[modelId]) {
            const limit = acc.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime > Date.now()) {
                return false;
            }
        }

        return true;
    });
}

/**
 * Get list of invalid accounts
 *
 * @param {Array} accounts - Array of account objects
 * @returns {Array} Array of invalid account objects
 */
export function getInvalidAccounts(accounts) {
    return accounts.filter(acc => acc.isInvalid);
}

/**
 * Clear expired rate limits
 *
 * @param {Array} accounts - Array of account objects
 * @returns {number} Number of rate limits cleared
 */
export function clearExpiredLimits(accounts) {
    const now = Date.now();
    let cleared = 0;

    for (const account of accounts) {
        if (account.modelRateLimits) {
            for (const [modelId, limit] of Object.entries(account.modelRateLimits)) {
                if (limit.isRateLimited && limit.resetTime <= now) {
                    limit.isRateLimited = false;
                    limit.resetTime = null;
                    cleared++;
                    logger.success(`[AccountManager] Rate limit expired for: ${account.email} (model: ${modelId})`);
                }
            }
        }
    }

    return cleared;
}

/**
 * Clear all rate limits to force a fresh check (optimistic retry strategy)
 *
 * @param {Array} accounts - Array of account objects
 */
export function resetAllRateLimits(accounts) {
    for (const account of accounts) {
        if (account.modelRateLimits) {
            for (const key of Object.keys(account.modelRateLimits)) {
                account.modelRateLimits[key] = { isRateLimited: false, resetTime: null };
            }
        }
    }
    logger.warn('[AccountManager] Reset all rate limits for optimistic retry');
}

/**
 * Mark an account as rate-limited for a specific model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to mark
 * @param {number|null} resetMs - Time in ms until rate limit resets
 * @param {Object} settings - Settings object with cooldownDurationMs
 * @param {string} modelId - Model ID to mark rate limit for
 * @returns {boolean} True if account was found and marked
 */
export function markRateLimited(accounts, email, resetMs = null, settings = {}, modelId) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    const cooldownMs = resetMs || settings.cooldownDurationMs || DEFAULT_COOLDOWN_MS;
    const resetTime = Date.now() + cooldownMs;

    if (!account.modelRateLimits) {
        account.modelRateLimits = {};
    }

    account.modelRateLimits[modelId] = {
        isRateLimited: true,
        resetTime: resetTime
    };

    logger.warn(
        `[AccountManager] Rate limited: ${email} (model: ${modelId}). Available in ${formatDuration(cooldownMs)}`
    );

    return true;
}

/**
 * Mark an account as invalid (credentials need re-authentication)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to mark
 * @param {string} reason - Reason for marking as invalid
 * @returns {boolean} True if account was found and marked
 */
export function markInvalid(accounts, email, reason = 'Unknown error') {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    account.isInvalid = true;
    account.invalidReason = reason;
    account.invalidAt = Date.now();

    logger.error(
        `[AccountManager] ⚠ Account INVALID: ${email}`
    );
    logger.error(
        `[AccountManager]   Reason: ${reason}`
    );
    logger.error(
        `[AccountManager]   Run 'npm run accounts' to re-authenticate this account`
    );

    return true;
}

/**
 * Get the minimum wait time until any account becomes available for a model
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check
 * @returns {number} Wait time in milliseconds
 */
export function getMinWaitTimeMs(accounts, modelId) {
    if (!isAllRateLimited(accounts, modelId)) return 0;

    const now = Date.now();
    let minWait = Infinity;
    let soonestAccount = null;

    for (const account of accounts) {
        if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
            const limit = account.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime) {
                const wait = limit.resetTime - now;
                if (wait > 0 && wait < minWait) {
                    minWait = wait;
                    soonestAccount = account;
                }
            }
        }
    }

    if (soonestAccount) {
        logger.info(`[AccountManager] Shortest wait: ${formatDuration(minWait)} (account: ${soonestAccount.email})`);
    }

    return minWait === Infinity ? DEFAULT_COOLDOWN_MS : minWait;
}

/**
 * Check if an account is soft-limited for a specific model
 * Soft limit means quota is below threshold but not exhausted
 *
 * @param {Object} account - Account object
 * @param {string} modelId - Model ID to check
 * @param {number} [threshold] - Threshold fraction (default: SOFT_LIMIT_THRESHOLD)
 * @returns {boolean} True if account is soft-limited
 */
export function isSoftLimited(account, modelId, threshold = SOFT_LIMIT_THRESHOLD) {
    if (!account || !modelId) return false;
    if (!account.modelSoftLimits) return false;

    const limit = account.modelSoftLimits[modelId];
    if (!limit || !limit.isSoftLimited) return false;

    // Check if soft limit has expired (quota should have reset)
    if (limit.resetTime && limit.resetTime <= Date.now()) {
        return false;
    }

    return true;
}

/**
 * Get accounts that are not soft-limited for a model (preferred accounts)
 * These accounts have quota above the soft limit threshold
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} [modelId] - Model ID to filter by
 * @param {number} [threshold] - Threshold fraction (default: SOFT_LIMIT_THRESHOLD)
 * @returns {Array} Array of accounts not soft-limited
 */
export function getPreferredAccounts(accounts, modelId = null, threshold = SOFT_LIMIT_THRESHOLD) {
    return accounts.filter(acc => {
        if (acc.isInvalid) return false;

        // Check hard rate limit first
        if (modelId && acc.modelRateLimits && acc.modelRateLimits[modelId]) {
            const limit = acc.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime > Date.now()) {
                return false;
            }
        }

        // Check soft limit
        if (modelId && isSoftLimited(acc, modelId, threshold)) {
            return false;
        }

        return true;
    });
}

/**
 * Check if all accounts are soft-limited for a specific model
 * (but not necessarily rate-limited - they can still be used as fallback)
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} modelId - Model ID to check
 * @param {number} [threshold] - Threshold fraction (default: SOFT_LIMIT_THRESHOLD)
 * @returns {boolean} True if all available accounts are soft-limited
 */
export function isAllSoftLimited(accounts, modelId, threshold = SOFT_LIMIT_THRESHOLD) {
    if (accounts.length === 0) return true;
    if (!modelId) return false;

    // Get accounts that are not hard rate-limited
    const available = getAvailableAccounts(accounts, modelId);
    if (available.length === 0) return false; // All are hard rate-limited, not soft-limited

    // Check if all available accounts are soft-limited
    return available.every(acc => isSoftLimited(acc, modelId, threshold));
}

/**
 * Mark an account as soft-limited for a specific model
 * This means quota is below threshold but not exhausted
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account to mark
 * @param {string} modelId - Model ID to mark soft limit for
 * @param {number} remainingFraction - Current remaining quota fraction (0.0-1.0)
 * @param {string|null} resetTime - ISO timestamp when quota resets
 * @param {number} [threshold] - Threshold that was exceeded (for logging)
 * @returns {boolean} True if account was found and marked
 */
export function markSoftLimited(accounts, email, modelId, remainingFraction, resetTime = null, threshold = SOFT_LIMIT_THRESHOLD) {
    const account = accounts.find(a => a.email === email);
    if (!account) return false;

    if (!account.modelSoftLimits) {
        account.modelSoftLimits = {};
    }

    // Parse reset time to milliseconds
    let resetMs = null;
    if (resetTime) {
        resetMs = new Date(resetTime).getTime();
    }

    account.modelSoftLimits[modelId] = {
        isSoftLimited: true,
        remainingFraction: remainingFraction,
        resetTime: resetMs,
        markedAt: Date.now()
    };

    const pct = Math.round(remainingFraction * 100);
    const thresholdPct = Math.round(threshold * 100);
    logger.warn(
        `[AccountManager] Soft limited: ${email} (model: ${modelId}) at ${pct}% (threshold: ${thresholdPct}%)`
    );

    return true;
}

/**
 * Clear soft limit for an account/model when quota refreshes
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @param {string} modelId - Model ID to clear soft limit for
 * @returns {boolean} True if soft limit was cleared
 */
export function clearSoftLimit(accounts, email, modelId) {
    const account = accounts.find(a => a.email === email);
    if (!account || !account.modelSoftLimits || !account.modelSoftLimits[modelId]) {
        return false;
    }

    delete account.modelSoftLimits[modelId];
    logger.success(`[AccountManager] Soft limit cleared: ${email} (model: ${modelId})`);
    return true;
}

/**
 * Clear expired soft limits based on reset time
 *
 * @param {Array} accounts - Array of account objects
 * @returns {number} Number of soft limits cleared
 */
export function clearExpiredSoftLimits(accounts) {
    const now = Date.now();
    let cleared = 0;

    for (const account of accounts) {
        if (account.modelSoftLimits) {
            for (const [modelId, limit] of Object.entries(account.modelSoftLimits)) {
                if (limit.isSoftLimited && limit.resetTime && limit.resetTime <= now) {
                    delete account.modelSoftLimits[modelId];
                    cleared++;
                    logger.success(`[AccountManager] Soft limit expired for: ${account.email} (model: ${modelId})`);
                }
            }
        }
    }

    return cleared;
}

/**
 * Update soft limit status based on quota info from API
 * Marks as soft-limited if below threshold, clears if above
 *
 * @param {Array} accounts - Array of account objects
 * @param {string} email - Email of the account
 * @param {string} modelId - Model ID to update
 * @param {number} remainingFraction - Current remaining quota fraction (0.0-1.0)
 * @param {string|null} resetTime - ISO timestamp when quota resets
 * @param {number} [threshold] - Soft limit threshold (default: SOFT_LIMIT_THRESHOLD)
 * @returns {{changed: boolean, isSoftLimited: boolean}} Whether status changed and current state
 */
export function updateSoftLimitStatus(accounts, email, modelId, remainingFraction, resetTime = null, threshold = SOFT_LIMIT_THRESHOLD) {
    const account = accounts.find(a => a.email === email);
    if (!account) return { changed: false, isSoftLimited: false };

    const wasSoftLimited = isSoftLimited(account, modelId, threshold);
    const shouldBeSoftLimited = remainingFraction !== null && remainingFraction < threshold && remainingFraction >= 0;

    if (shouldBeSoftLimited && !wasSoftLimited) {
        markSoftLimited(accounts, email, modelId, remainingFraction, resetTime, threshold);
        return { changed: true, isSoftLimited: true };
    } else if (!shouldBeSoftLimited && wasSoftLimited) {
        clearSoftLimit(accounts, email, modelId);
        return { changed: true, isSoftLimited: false };
    }

    return { changed: false, isSoftLimited: wasSoftLimited };
}
