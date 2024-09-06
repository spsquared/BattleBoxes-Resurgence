// yes it's copied from WWPPC

import { randomUUID } from "crypto";

/**
 * Basic access token system with linked data.
 * @type {DType} Type of linked data
 */
export class SessionTokenHandler<DType> {
    readonly #tokens: Map<string, { data: DType, expiration?: number }> = new Map();

    constructor() {
        setInterval(() => {
            for (const [token, data] of this.#tokens) {
                if (data.expiration !== undefined && data.expiration < Date.now()) {
                    this.#tokens.delete(token);
                }
            }
        }, 1000);
    }

    /**
     * Create and register a new token that optionally expires after some time.
     * @param {DType} linkedData Data to associate with the new token
     * @param {number | undefined} expiration Seconds until expiration removes the token
     * @returns {string} Access token
     */
    createToken(linkedData: DType, expiration?: number): string {
        const token = randomUUID();
        this.#tokens.set(token, { data: linkedData, expiration: expiration === undefined ? expiration : Date.now() + expiration * 1000 });
        return token;
    }

    /**
     * Get a map of all tokens and corresponding data.
     * @returns {Map<string, DType>} Copy of token map
     */
    getTokens(): Map<string, DType> {
        const ret = new Map<string, DType>();
        this.#tokens.forEach((v, k) => ret.set(k, v.data));
        return ret;
    }

    /**
     * Check if a token is registered.
     * @param {string} token Token to check
     * @returns {boolean} If the token is registered
     */
    tokenExists(token: string): boolean {
        return this.#tokens.has(token);
    }

    /**
     * Check token expiration time.
     * @param {string} token Token to check
     * @returns {number | undefined} Expiration time, if the token exists and has an expiration
     */
    tokenExpiration(token: string): number | undefined {
        return this.tokenExists(token) ? this.#tokens.get(token)!.expiration : undefined;
    }

    /**
     * Update token expiration time.
     * @param {string} token Token to update
     * @param {number} expiration New expiration duration in seconds, added onto the current time
     * @returns {boolean} If a token was found and the expiration time updated
     */
    extendTokenExpiration(token: string, expiration: number): boolean {
        if (!this.tokenExists(token)) return false;
        this.#tokens.get(token)!.expiration = Date.now() + (expiration * 1000);
        return true;
    }

    /**
     * Get the linked data for a token if it exists.
     * @param {string} token Token to check
     * @returns {DType | null} Token linked data or null if not exists
     */
    tokenData(token: string): DType | null {
        if (!this.#tokens.has(token)) return null;
        return this.#tokens.get(token)!.data;
    }

    /**
     * Unregister a token for all permissions.
     * @param {string} token Token to unregister
     * @returns {boolean} If a token was previously registered and is now unregistered
     */
    removeToken(token: string): boolean {
        return this.#tokens.delete(token);
    }
}