/**
 * Model API for Cloud Code
 *
 * Handles model listing and quota retrieval from the Cloud Code API.
 * Includes soft limit checking to prevent quota exhaustion.
 */

import { ANTIGRAVITY_ENDPOINT_FALLBACKS, ANTIGRAVITY_HEADERS, getModelFamily, SOFT_LIMIT_THRESHOLD } from '../constants.js';
import { logger } from '../utils/logger.js';

/**
 * Check if a model is supported (Claude or Gemini)
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if model is supported
 */
function isSupportedModel(modelId) {
    const family = getModelFamily(modelId);
    return family === 'claude' || family === 'gemini';
}

/**
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
export async function listModels(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) {
        return { object: 'list', data: [] };
    }

    const modelList = Object.entries(data.models)
        .filter(([modelId]) => isSupportedModel(modelId))
        .map(([modelId, modelData]) => ({
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
        description: modelData.displayName || modelId
    }));

    return {
        object: 'list',
        data: modelList
    };
}

/**
 * Fetch available models with quota info from Cloud Code API
 * Returns model quotas including remaining fraction and reset time
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<Object>} Raw response from fetchAvailableModels API
 */
export async function fetchAvailableModels(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({})
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                continue;
            }

            return await response.json();
        } catch (error) {
            logger.warn(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
        }
    }

    throw new Error('Failed to fetch available models from all endpoints');
}

/**
 * Get model quotas for an account
 * Extracts quota info (remaining fraction and reset time) for each model
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime }
 */
export async function getModelQuotas(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) return {};

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        // Only include Claude and Gemini models
        if (!isSupportedModel(modelId)) continue;

        if (modelData.quotaInfo) {
            quotas[modelId] = {
                remainingFraction: modelData.quotaInfo.remainingFraction ?? null,
                resetTime: modelData.quotaInfo.resetTime ?? null
            };
        }
    }

    return quotas;
}

/**
 * Check and update soft limit status for an account after a request.
 * Fetches the current quota and updates the soft limit status if needed.
 *
 * This should be called after a successful request to proactively detect
 * when an account's quota is running low before it's completely exhausted.
 *
 * @param {Object} account - Account object with email and credentials
 * @param {string} modelId - Model ID that was used
 * @param {string} token - OAuth access token for the account
 * @param {import('../account-manager/index.js').default} accountManager - The account manager instance
 * @returns {Promise<{checked: boolean, isSoftLimited: boolean, remainingFraction: number|null}>} Check result
 */
export async function checkAndUpdateSoftLimit(account, modelId, token, accountManager) {
    // Skip if soft limits are disabled
    if (!accountManager.isSoftLimitEnabled()) {
        return { checked: false, isSoftLimited: false, remainingFraction: null };
    }

    try {
        const quotas = await getModelQuotas(token);
        const quota = quotas[modelId];

        if (!quota || quota.remainingFraction === null) {
            return { checked: true, isSoftLimited: false, remainingFraction: null };
        }

        const { changed, isSoftLimited } = accountManager.updateSoftLimitStatus(
            account.email,
            modelId,
            quota.remainingFraction,
            quota.resetTime
        );

        if (changed) {
            const pct = Math.round(quota.remainingFraction * 100);
            if (isSoftLimited) {
                logger.warn(`[CloudCode] Account ${account.email} now soft-limited for ${modelId} at ${pct}%`);
            } else {
                logger.success(`[CloudCode] Account ${account.email} no longer soft-limited for ${modelId} (${pct}%)`);
            }
        }

        return { checked: true, isSoftLimited, remainingFraction: quota.remainingFraction };
    } catch (error) {
        // Don't fail the request if quota check fails, just log and continue
        logger.debug(`[CloudCode] Failed to check quota for soft limit: ${error.message}`);
        return { checked: false, isSoftLimited: false, remainingFraction: null };
    }
}
