/**
 * Account Manager
 * Manages multiple Antigravity accounts with sticky selection,
 * automatic failover, and smart cooldown for rate-limited accounts.
 */

import { ACCOUNT_CONFIG_PATH, SOFT_LIMIT_THRESHOLD } from '../constants.js';
import { loadAccounts, loadDefaultAccount, saveAccounts } from './storage.js';
import {
    isAllRateLimited as checkAllRateLimited,
    getAvailableAccounts as getAvailable,
    getInvalidAccounts as getInvalid,
    clearExpiredLimits as clearLimits,
    resetAllRateLimits as resetLimits,
    markRateLimited as markLimited,
    markInvalid as markAccountInvalid,
    getMinWaitTimeMs as getMinWait,
    // Soft limit functions
    isSoftLimited as checkSoftLimited,
    isAllSoftLimited as checkAllSoftLimited,
    getPreferredAccounts as getPreferred,
    markSoftLimited as markSoftLim,
    clearSoftLimit as clearSoftLim,
    clearExpiredSoftLimits as clearExpiredSoftLims,
    updateSoftLimitStatus as updateSoftLimStatus
} from './rate-limits.js';
import {
    getTokenForAccount as fetchToken,
    getProjectForAccount as fetchProject,
    clearProjectCache as clearProject,
    clearTokenCache as clearToken
} from './credentials.js';
import {
    pickNext as selectNext,
    getCurrentStickyAccount as getSticky,
    shouldWaitForCurrentAccount as shouldWait,
    pickStickyAccount as selectSticky
} from './selection.js';
import { logger } from '../utils/logger.js';

export class AccountManager {
    #accounts = [];
    #currentIndex = 0;
    #configPath;
    #settings = {};
    #initialized = false;
    #softLimitEnabled = true; // Whether soft limits are active
    #softLimitThreshold = SOFT_LIMIT_THRESHOLD; // Configurable threshold

    // Per-account caches
    #tokenCache = new Map(); // email -> { token, extractedAt }
    #projectCache = new Map(); // email -> projectId

    constructor(configPath = ACCOUNT_CONFIG_PATH) {
        this.#configPath = configPath;
    }

    /**
     * Enable or disable soft limits
     * @param {boolean} enabled - Whether to enable soft limits
     * @param {number} [threshold] - Optional custom threshold (0.0-1.0)
     */
    setSoftLimitEnabled(enabled, threshold = null) {
        this.#softLimitEnabled = enabled;
        if (threshold !== null && threshold >= 0 && threshold <= 1) {
            this.#softLimitThreshold = threshold;
        }
        logger.info(`[AccountManager] Soft limits ${enabled ? 'enabled' : 'disabled'}${enabled && threshold !== null ? ` at ${Math.round(threshold * 100)}% threshold` : ''}`);
    }

    /**
     * Check if soft limits are enabled
     * @returns {boolean} True if soft limits are enabled
     */
    isSoftLimitEnabled() {
        return this.#softLimitEnabled;
    }

    /**
     * Get the soft limit threshold
     * @returns {number} Threshold fraction (0.0-1.0)
     */
    getSoftLimitThreshold() {
        return this.#softLimitThreshold;
    }

    /**
     * Initialize the account manager by loading config
     */
    async initialize() {
        if (this.#initialized) return;

        const { accounts, settings, activeIndex } = await loadAccounts(this.#configPath);

        this.#accounts = accounts;
        this.#settings = settings;
        this.#currentIndex = activeIndex;

        // If config exists but has no accounts, fall back to Antigravity database
        if (this.#accounts.length === 0) {
            logger.warn('[AccountManager] No accounts in config. Falling back to Antigravity database');
            const { accounts: defaultAccounts, tokenCache } = loadDefaultAccount();
            this.#accounts = defaultAccounts;
            this.#tokenCache = tokenCache;
        }

        // Clear any expired rate limits
        this.clearExpiredLimits();

        this.#initialized = true;
    }

    /**
     * Get the number of accounts
     * @returns {number} Number of configured accounts
     */
    getAccountCount() {
        return this.#accounts.length;
    }

    /**
     * Check if all accounts are rate-limited
     * @param {string} [modelId] - Optional model ID
     * @returns {boolean} True if all accounts are rate-limited
     */
    isAllRateLimited(modelId = null) {
        return checkAllRateLimited(this.#accounts, modelId);
    }

    /**
     * Get list of available (non-rate-limited, non-invalid) accounts
     * @param {string} [modelId] - Optional model ID
     * @returns {Array<Object>} Array of available account objects
     */
    getAvailableAccounts(modelId = null) {
        return getAvailable(this.#accounts, modelId);
    }

    /**
     * Get list of invalid accounts
     * @returns {Array<Object>} Array of invalid account objects
     */
    getInvalidAccounts() {
        return getInvalid(this.#accounts);
    }

    /**
     * Clear expired rate limits (and soft limits)
     * @returns {number} Number of limits cleared
     */
    clearExpiredLimits() {
        const clearedRate = clearLimits(this.#accounts);
        const clearedSoft = clearExpiredSoftLims(this.#accounts);
        const cleared = clearedRate + clearedSoft;
        if (cleared > 0) {
            this.saveToDisk();
        }
        return cleared;
    }

    /**
     * Clear all rate limits to force a fresh check
     * (Optimistic retry strategy)
     * @returns {void}
     */
    resetAllRateLimits() {
        resetLimits(this.#accounts);
    }

    /**
     * Pick the next available account (fallback when current is unavailable).
     * Sets activeIndex to the selected account's index.
     * Respects soft limits if enabled.
     * @param {string} [modelId] - Optional model ID
     * @returns {Object|null} The next available account or null if none available
     */
    pickNext(modelId = null) {
        const { account, newIndex } = selectNext(
            this.#accounts,
            this.#currentIndex,
            () => this.saveToDisk(),
            modelId,
            this.#softLimitEnabled
        );
        this.#currentIndex = newIndex;
        return account;
    }

    /**
     * Get the current account without advancing the index (sticky selection).
     * Used for cache continuity - sticks to the same account until rate-limited.
     * @param {string} [modelId] - Optional model ID
     * @returns {Object|null} The current account or null if unavailable/rate-limited
     */
    getCurrentStickyAccount(modelId = null) {
        const { account, newIndex } = getSticky(this.#accounts, this.#currentIndex, () => this.saveToDisk(), modelId);
        this.#currentIndex = newIndex;
        return account;
    }

    /**
     * Check if we should wait for the current account's rate limit to reset.
     * Used for sticky account selection - wait if rate limit is short (≤ threshold).
     * @param {string} [modelId] - Optional model ID
     * @returns {{shouldWait: boolean, waitMs: number, account: Object|null}}
     */
    shouldWaitForCurrentAccount(modelId = null) {
        return shouldWait(this.#accounts, this.#currentIndex, modelId);
    }

    /**
     * Pick an account with sticky selection preference.
     * Prefers the current account for cache continuity, only switches when:
     * - Current account is rate-limited for > 2 minutes
     * - Current account is invalid
     * - Current account is soft-limited AND preferred alternatives exist
     * @param {string} [modelId] - Optional model ID
     * @returns {{account: Object|null, waitMs: number}} Account to use and optional wait time
     */
    pickStickyAccount(modelId = null) {
        const { account, waitMs, newIndex } = selectSticky(
            this.#accounts,
            this.#currentIndex,
            () => this.saveToDisk(),
            modelId,
            this.#softLimitEnabled
        );
        this.#currentIndex = newIndex;
        return { account, waitMs };
    }

    /**
     * Mark an account as rate-limited
     * @param {string} email - Email of the account to mark
     * @param {number|null} resetMs - Time in ms until rate limit resets (optional)
     * @param {string} [modelId] - Optional model ID to mark specific limit
     */
    markRateLimited(email, resetMs = null, modelId = null) {
        markLimited(this.#accounts, email, resetMs, this.#settings, modelId);
        this.saveToDisk();
    }

    /**
     * Mark an account as invalid (credentials need re-authentication)
     * @param {string} email - Email of the account to mark
     * @param {string} reason - Reason for marking as invalid
     */
    markInvalid(email, reason = 'Unknown error') {
        markAccountInvalid(this.#accounts, email, reason);
        this.saveToDisk();
    }

    /**
     * Get the minimum wait time until any account becomes available
     * @param {string} [modelId] - Optional model ID
     * @returns {number} Wait time in milliseconds
     */
    getMinWaitTimeMs(modelId = null) {
        return getMinWait(this.#accounts, modelId);
    }

    /**
     * Get OAuth token for an account
     * @param {Object} account - Account object with email and credentials
     * @returns {Promise<string>} OAuth access token
     * @throws {Error} If token refresh fails
     */
    async getTokenForAccount(account) {
        return fetchToken(
            account,
            this.#tokenCache,
            (email, reason) => this.markInvalid(email, reason),
            () => this.saveToDisk()
        );
    }

    /**
     * Get project ID for an account
     * @param {Object} account - Account object
     * @param {string} token - OAuth access token
     * @returns {Promise<string>} Project ID
     */
    async getProjectForAccount(account, token) {
        return fetchProject(account, token, this.#projectCache);
    }

    /**
     * Clear project cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearProjectCache(email = null) {
        clearProject(this.#projectCache, email);
    }

    /**
     * Clear token cache for an account (useful on auth errors)
     * @param {string|null} email - Email to clear cache for, or null to clear all
     */
    clearTokenCache(email = null) {
        clearToken(this.#tokenCache, email);
    }

    /**
     * Save current state to disk (async)
     * @returns {Promise<void>}
     */
    async saveToDisk() {
        await saveAccounts(this.#configPath, this.#accounts, this.#settings, this.#currentIndex);
    }

    /**
     * Get status object for logging/API
     * @returns {{accounts: Array, settings: Object}} Status object with accounts and settings
     */
    getStatus() {
        const available = this.getAvailableAccounts();
        const invalid = this.getInvalidAccounts();

        // Count accounts that have any active model-specific rate limits
        const rateLimited = this.#accounts.filter(a => {
            if (!a.modelRateLimits) return false;
            return Object.values(a.modelRateLimits).some(
                limit => limit.isRateLimited && limit.resetTime > Date.now()
            );
        });

        // Count accounts that have any active model-specific soft limits
        const softLimited = this.#accounts.filter(a => {
            if (!a.modelSoftLimits) return false;
            return Object.values(a.modelSoftLimits).some(
                limit => limit.isSoftLimited && (!limit.resetTime || limit.resetTime > Date.now())
            );
        });

        return {
            total: this.#accounts.length,
            available: available.length,
            rateLimited: rateLimited.length,
            softLimited: softLimited.length,
            invalid: invalid.length,
            softLimitEnabled: this.#softLimitEnabled,
            softLimitThreshold: this.#softLimitThreshold,
            summary: `${this.#accounts.length} total, ${available.length} available, ${rateLimited.length} rate-limited, ${softLimited.length} soft-limited, ${invalid.length} invalid`,
            accounts: this.#accounts.map(a => ({
                email: a.email,
                source: a.source,
                modelRateLimits: a.modelRateLimits || {},
                modelSoftLimits: a.modelSoftLimits || {},
                isInvalid: a.isInvalid || false,
                invalidReason: a.invalidReason || null,
                lastUsed: a.lastUsed
            }))
        };
    }

    /**
     * Get settings
     * @returns {Object} Current settings object
     */
    getSettings() {
        return { ...this.#settings };
    }

    /**
     * Get all accounts (internal use for quota fetching)
     * Returns the full account objects including credentials
     * @returns {Array<Object>} Array of account objects
     */
    getAllAccounts() {
        return this.#accounts;
    }

    // ==================== Soft Limit Methods ====================

    /**
     * Check if an account is soft-limited for a model
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @returns {boolean} True if account is soft-limited
     */
    isSoftLimited(email, modelId) {
        const account = this.#accounts.find(a => a.email === email);
        if (!account) return false;
        return checkSoftLimited(account, modelId, this.#softLimitThreshold);
    }

    /**
     * Check if all accounts are soft-limited for a model
     * @param {string} modelId - Model ID
     * @returns {boolean} True if all available accounts are soft-limited
     */
    isAllSoftLimited(modelId) {
        return checkAllSoftLimited(this.#accounts, modelId, this.#softLimitThreshold);
    }

    /**
     * Get preferred accounts (not soft-limited) for a model
     * @param {string} [modelId] - Optional model ID
     * @returns {Array<Object>} Array of preferred account objects
     */
    getPreferredAccounts(modelId = null) {
        return getPreferred(this.#accounts, modelId, this.#softLimitThreshold);
    }

    /**
     * Mark an account as soft-limited
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @param {number} remainingFraction - Current remaining quota (0.0-1.0)
     * @param {string|null} resetTime - ISO timestamp when quota resets
     */
    markSoftLimited(email, modelId, remainingFraction, resetTime = null) {
        markSoftLim(this.#accounts, email, modelId, remainingFraction, resetTime, this.#softLimitThreshold);
        this.saveToDisk();
    }

    /**
     * Clear soft limit for an account/model
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     */
    clearSoftLimit(email, modelId) {
        clearSoftLim(this.#accounts, email, modelId);
        this.saveToDisk();
    }

    /**
     * Update soft limit status based on quota info
     * Automatically marks or clears soft limit based on remaining quota
     * @param {string} email - Account email
     * @param {string} modelId - Model ID
     * @param {number} remainingFraction - Current remaining quota (0.0-1.0)
     * @param {string|null} resetTime - ISO timestamp when quota resets
     * @returns {{changed: boolean, isSoftLimited: boolean}} Whether status changed
     */
    updateSoftLimitStatus(email, modelId, remainingFraction, resetTime = null) {
        const result = updateSoftLimStatus(
            this.#accounts,
            email,
            modelId,
            remainingFraction,
            resetTime,
            this.#softLimitThreshold
        );
        if (result.changed) {
            this.saveToDisk();
        }
        return result;
    }
}

export default AccountManager;
