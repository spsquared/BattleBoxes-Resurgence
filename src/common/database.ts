import bcrypt from 'bcrypt';
import { existsSync, readFile, writeFile } from 'fs';
import { resolve as pathResolve } from 'path';
import { Client } from 'pg';

import { decode as msgpackDecode, encode as msgpackEncode } from '@msgpack/msgpack';

import config from '../config';
import Logger, { NamedLogger } from './log';

const salt = 5;

export interface Database {
    readonly logger: NamedLogger;

    /**
     * Async function that resolves when database is ready to process requests.
     */
    connect: () => Promise<void>;
    /**
     * Disconnects database and disables request processing.
     */
    disconnect: () => Promise<void>;

    /**
     * Fetches a list of all usernames from the database.
     * @returns List of usernames, or null if error occured
     */
    getAccountList(): Promise<string[] | null>;
    /**
     * Create an account in the database.
     * @param username Unique username - operation fails if not distinct
     * @param password Password - irretrievable after write, will be encrypted with bcrypt
     * @returns Creation status
     */
    createAccount(username: string, password: string): Promise<AccountOpResult>;
    /**
     * Check credentials against an existing account.
     * @param username Username
     * @param password Password
     * @returns Check status
     */
    checkAccount(username: string, password: string): Promise<AccountOpResult>;
    /**
     * Get user data for an account.
     * @param username Username
     * @returns AccountData or an error code
     */
    getAccountData(username: string): Promise<AccountData | AccountOpResult>;
    /**
     * Overwrite user data for an account. *Only uses part of the data*.
     * @param username Username
     * @param userData New data - not all is used
     * @returns Update status
     */
    updateAccountData(userData: AccountData): Promise<AccountOpResult>;
    /**
     * Change the password of an account. Requires that the existing password is correct.
     * @param username Username
     * @param password Current password
     * @param newPassword New password
     * @returns Update status
     */
    changeAccountPassword(username: string, password: string, newPassword: string): Promise<AccountOpResult>;
    /**
     * Delete an account. Requires that the password is correct.
     * @param username Username
     * @param password Password
     * @returns Deletion status
     */
    deleteAccount(username: string, password: string): Promise<AccountOpResult>;
}

export interface FileDatabaseConstructorParams {
    /**Optionally change file location */
    path?: string
    /**Logging instance */
    logger: Logger
}
/**
 * File implementation of database
 */
export class FileDatabase implements Database {
    readonly logger: NamedLogger;
    private readonly file: string;
    private readonly data: {
        accounts: Map<string, FileDatabaseAccount>
    } = {
            accounts: new Map()
        };
    private readonly saveInterval: NodeJS.Timeout;

    constructor({ path, logger }: FileDatabaseConstructorParams) {
        this.logger = new NamedLogger(logger, 'FileDatabase');
        this.file = pathResolve(path ?? config.path, 'database.db');
        if (!existsSync(this.file)) this.writetoFile();
        this.saveInterval = setInterval(() => this.writetoFile(), 60000);
    }

    #activity: Set<Promise<void>> = new Set();
    private async writetoFile() {
        await this.#activity;
        const op = new Promise<void>((resolve) => {
            const data = {
                accounts: Array.from(this.data.accounts.entries()).reduce<Record<string, FileDatabaseAccount>>((p, c) => {
                    p[c[0]] = c[1];
                    return p;
                }, {})
            };
            writeFile(this.file, msgpackEncode(data), (err) => {
                if (err) {
                    this.logger.handleFatal('Fatal database error:', err);
                    process.exit(1);
                }
                resolve();
                this.#activity.delete(op);
            });
        });
        this.#activity.add(op);
        await op;
    }

    async connect(): Promise<void> {
        await Promise.all(this.#activity);
        await new Promise<void>((resolve) => {
            readFile(this.file, (err, raw) => {
                try {
                    const data: any = msgpackDecode(raw);
                    if (data == null || typeof data != 'object') {
                        this.logger.fatal('Database file is of invalid type');
                        this.logger.fatal('Contents: ' + JSON.stringify(data));
                        process.exit(1);
                    }
                    this.data.accounts.clear();
                    for (const username in data.accounts) {
                        const account: FileDatabaseAccount = data.accounts[username];
                        this.data.accounts.set(username, {
                            username: account.username,
                            password: account.password,
                            xp: account.xp ?? 0,
                            trackers: {
                                time: account.trackers?.time ?? 0,
                                distanceMoved: account.trackers?.distanceMoved ?? 0,
                                airTime: account.trackers?.airTime ?? 0,
                                jumps: account.trackers?.jumps ?? 0,
                                wallJumps: account.trackers?.wallJumps ?? 0,
                                fallDistance: account.trackers?.fallDistance ?? 0,
                                wallSlideDistance: account.trackers?.wallSlideDistance ?? 0,
                                shotsFired: account.trackers?.shotsFired ?? 0,
                                damageDealt: account.trackers?.damageDealt ?? 0,
                                damagetaken: account.trackers?.damagetaken ?? 0,
                                damageAbsorbed: account.trackers?.damageAbsorbed ?? 0,
                                lootboxesOpened: account.trackers?.lootboxesOpened ?? 0
                            },
                            achievements: [],
                            infractions: []
                        });
                    }
                    resolve();
                } catch (err) {
                    this.logger.fatal('Database file is of invalid type');
                    process.exit(1);
                }
            });
        });
    }
    async disconnect(): Promise<void> {
        clearInterval(this.saveInterval);
        await this.writetoFile();
        await Promise.all(this.#activity);
    }

    async getAccountList(): Promise<string[] | null> {
        return Array.from(this.data.accounts.keys());
    }
    async createAccount(username: string, password: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.ALREADY_EXISTS> {
        if (this.data.accounts.has(username)) return AccountOpResult.ALREADY_EXISTS;
        this.data.accounts.set(username, {
            username: username,
            password: await bcrypt.hash(password, salt),
            xp: 0,
            trackers: {
                time: 0,
                distanceMoved: 0,
                airTime: 0,
                jumps: 0,
                wallJumps: 0,
                fallDistance: 0,
                wallSlideDistance: 0,
                shotsFired: 0,
                damageDealt: 0,
                damagetaken: 0,
                damageAbsorbed: 0,
                lootboxesOpened: 0
            },
            achievements: [],
            infractions: []
        });
        return AccountOpResult.SUCCESS;
    }
    async checkAccount(username: string, password: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS | AccountOpResult.INCORRECT_CREDENTIALS> {
        if (!this.data.accounts.has(username)) return AccountOpResult.NOT_EXISTS;
        if (await bcrypt.compare(password, this.data.accounts.get(username)!.password)) return AccountOpResult.SUCCESS;
        return AccountOpResult.INCORRECT_CREDENTIALS;
    }
    async getAccountData(username: string): Promise<AccountData | AccountOpResult.NOT_EXISTS> {
        if (!this.data.accounts.has(username)) return AccountOpResult.NOT_EXISTS;
        const ret: any = structuredClone(this.data.accounts.get(username)!);
        ret.password = undefined;
        return ret;
    }
    async updateAccountData(userData: AccountData): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS> {
        if (!this.data.accounts.has(userData.username)) return AccountOpResult.NOT_EXISTS;
        // object moment
        const existing = this.data.accounts.get(userData.username)!;
        existing.xp = userData.xp;
        existing.trackers = structuredClone(userData.trackers);
        existing.achievements = userData.achievements.slice();
        existing.infractions = structuredClone(userData.infractions);
        return AccountOpResult.SUCCESS;
    }
    async changeAccountPassword(username: string, password: string, newPassword: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS | AccountOpResult.INCORRECT_CREDENTIALS> {
        const res = await this.checkAccount(username, password);
        if (res != AccountOpResult.SUCCESS) return res;
        if (!this.data.accounts.has(username)) return AccountOpResult.NOT_EXISTS; // small chance of deletion mid-function
        const existing = this.data.accounts.get(username)!;
        this.data.accounts.set(username, {
            ...existing,
            password: await bcrypt.hash(newPassword, salt)
        });
        return AccountOpResult.SUCCESS
    }
    async deleteAccount(username: string, password: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS | AccountOpResult.INCORRECT_CREDENTIALS> {
        const res = await this.checkAccount(username, password);
        if (res != AccountOpResult.SUCCESS) return res;
        this.data.accounts.delete(username);
        return AccountOpResult.SUCCESS;
    }
}

export interface PsqlDatabaseConstructorParams {
    /**Valid PostgreSQL connection URI (postgresql://username:password@host:port/database) */
    uri: string
    /**Optional SSL Certificate */
    sslCert?: string | Buffer
    /**Logging instance */
    logger: Logger
}
/**
 * PostgreSQL database connection.
 */
export class PsqlDatabase implements Database {
    private readonly connectPromise: Promise<void>;

    private readonly db: Client;
    readonly logger: NamedLogger;

    constructor({ uri, sslCert, logger }: PsqlDatabaseConstructorParams) {
        const startTime = performance.now();
        this.logger = new NamedLogger(logger, 'PsqlDatabase');
        this.connectPromise = new Promise(() => undefined);
        this.db = new Client({
            connectionString: uri,
            application_name: 'BattleBoxes Main Server',
            ssl: sslCert != undefined ? { ca: sslCert } : { rejectUnauthorized: false }
        });
        this.connectPromise = this.db.connect().catch((err) => {
            this.logger.handleFatal('Could not connect to database:', err);
            this.logger.fatal('Host: ' + this.db.host);
            this.logger.destroy();
            process.exit(1);
        });
        this.connectPromise.then(() => {
            this.logger.info('Database connected');
            if (config.debugMode) {
                this.logger.debug(`Connected to ${this.db.host}`);
                this.logger.debug(`Connection time: ${performance.now() - startTime}ms`);
            }
        });
        this.db.on('error', (err) => {
            this.logger.handleFatal('Fatal database error:', err);
            this.logger.destroy();
            process.exit(1);
        });
    }

    async connect() {
        await this.connectPromise;
    }
    async disconnect() {
        await this.db.end();
        this.logger.info('Disconnected');
    }

    async getAccountList(): Promise<string[] | null> {
        const startTime = performance.now();
        try {
            const data = await this.db.query('SELECT users.username FROM users');
            if (data.rows.length > 0) return data.rows.map((r) => r.username);
            return null;
        } catch (err) {
            this.logger.handleError('Database error (getAccountList):', err);
            return null;
        } finally {
            if (config.debugMode) this.logger.debug(`getAccountList in ${performance.now() - startTime}ms`, true);
        }
    }
    async createAccount(username: string, password: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.ALREADY_EXISTS | AccountOpResult.ERROR> {
        const startTime = performance.now();
        try {
            const encryptedPassword = await bcrypt.hash(password, salt);
            const data = await this.db.query('SELECT username FROM users WHERE username=$1', [username]);
            if (data.rows.length > 0) return AccountOpResult.ALREADY_EXISTS;
            else await this.db.query('INSERT INTO users (username, password, xp, trackers, achievements, infractions) VALUES ($1, $2, $3, $4, $5, $6)', [username, encryptedPassword, 0, '{}', [], []]);
            this.logger.info(`Created account "${username}"`, true);
            return AccountOpResult.SUCCESS;
        } catch (err) {
            this.logger.handleError('Database error (createAccount):', err);
            return AccountOpResult.ERROR;
        } finally {
            if (config.debugMode) this.logger.debug(`createAccount in ${performance.now() - startTime}ms`, true);
        }
    }
    async checkAccount(username: string, password: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS | AccountOpResult.INCORRECT_CREDENTIALS | AccountOpResult.ERROR> {
        const startTime = performance.now();
        try {
            const data = await this.db.query('SELECT password FROM users WHERE username=$1', [username]);
            if (data.rows.length > 0) {
                if (await bcrypt.compare(password, data.rows[0].password)) return AccountOpResult.SUCCESS;
                return AccountOpResult.INCORRECT_CREDENTIALS;
            }
            return AccountOpResult.NOT_EXISTS;
        } catch (err) {
            this.logger.handleError('Database error (checkAccount):', err);
            return AccountOpResult.ERROR;
        } finally {
            if (config.debugMode) this.logger.debug(`checkAccount in ${performance.now() - startTime}ms`, true);
        }
    }
    async getAccountData(username: string): Promise<AccountData | AccountOpResult.NOT_EXISTS | AccountOpResult.ERROR> {
        const startTime = performance.now();
        try {
            const data = await this.db.query('SELECT username, xp, trackers, achievements, infractions FROM users WHERE username=$1', [username]);
            if (data.rows.length > 0) {
                const raw = data.rows[0];
                return {
                    username: raw.username,
                    xp: raw.xp,
                    trackers: {
                        time: raw.trackers.time ?? 0,
                        distanceMoved: raw.trackers.distanceMoved ?? 0,
                        airTime: raw.trackers.airTime ?? 0,
                        jumps: raw.trackers.jumps ?? 0,
                        wallJumps: raw.trackers.wallJumps ?? 0,
                        fallDistance: raw.trackers.fallDistance ?? 0,
                        wallSlideDistance: raw.trackers.wallSlideDistance ?? 0,
                        shotsFired: raw.trackers.shotsFired ?? 0,
                        damageDealt: raw.trackers.damageDealt ?? 0,
                        damagetaken: raw.trackers.damagetaken ?? 0,
                        damageAbsorbed: raw.trackers.damageAbsorbed ?? 0,
                        lootboxesOpened: raw.trackers.lootboxesOpened ?? 0
                    },
                    achievements: raw.achievements,
                    infractions: raw.infractions
                };
            }
            return AccountOpResult.NOT_EXISTS;
        } catch (err) {
            this.logger.handleError('Database error (getAccountData):', err);
            return AccountOpResult.ERROR;
        } finally {
            if (config.debugMode) this.logger.debug(`getAccountData in ${performance.now() - startTime}ms`, true);
        }
    }
    async updateAccountData(userData: AccountData): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS | AccountOpResult.ERROR> {
        const startTime = performance.now();
        try {
            const res = await this.db.query(
                'UPDATE users SET xp=$2, trackers=$3, achievements=$4, infractions=$5 WHERE username=$1 RETURNING username', [
                userData.username, userData.xp, JSON.stringify(userData.trackers), userData.achievements, userData.infractions
            ]);
            if (res.rows.length == 0) return AccountOpResult.NOT_EXISTS;
            return AccountOpResult.SUCCESS;
        } catch (err) {
            this.logger.handleError('Database error (updateAccountData):', err);
            return AccountOpResult.ERROR;
        } finally {
            if (config.debugMode) this.logger.debug(`updateAccountData in ${performance.now() - startTime}ms`, true);
        }
    }
    async changeAccountPassword(username: string, password: string, newPassword: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS | AccountOpResult.INCORRECT_CREDENTIALS | AccountOpResult.ERROR> {
        const startTime = performance.now();
        try {
            const res = await this.checkAccount(username, password);
            if (res != AccountOpResult.SUCCESS) return res;
            const encryptedPassword = await bcrypt.hash(newPassword, salt);
            await this.db.query('UPDATE users SET password=$2 WHERE username=$1', [username, encryptedPassword]);
            this.logger.info(`Reset password for "${username}"`, true);
            return AccountOpResult.SUCCESS;
        } catch (err) {
            this.logger.handleError('Database error (changeAccountPassword):', err);
            return AccountOpResult.ERROR;
        } finally {
            if (config.debugMode) this.logger.debug(`changeAccountPassword in ${performance.now() - startTime}ms`, true);
        }
    }
    async deleteAccount(username: string, password: string): Promise<AccountOpResult.SUCCESS | AccountOpResult.NOT_EXISTS | AccountOpResult.INCORRECT_CREDENTIALS | AccountOpResult.ERROR> {
        const startTime = performance.now();
        try {
            const res = await this.checkAccount(username, password);
            if (res != AccountOpResult.SUCCESS) return res;
            await this.db.query('DELETE FROM users WHERE username=$1', [username]);
            this.logger.info(`Deleted account ${username}`, true);
            return AccountOpResult.SUCCESS;
        } catch (err) {
            this.logger.handleError('Database error (deleteAccount):', err);
            return AccountOpResult.ERROR;
        } finally {
            if (config.debugMode) this.logger.debug(`deleteAccount in ${performance.now() - startTime}ms`, true);
        }
    }
}

/**Response codes for operations involving account data */
export enum AccountOpResult {
    /**The operation was completed successfully */
    SUCCESS,
    /**The operation failed because database cannot not overwrite existing account */
    ALREADY_EXISTS,
    /**The operation failed because the requested account does not exist */
    NOT_EXISTS,
    /**The operation failed because of an authentication failure */
    INCORRECT_CREDENTIALS,
    /**The operation failed because of an unexpected issue */
    ERROR
}

/**
 * Descriptor for an account
 */
export interface AccountData {
    readonly username: string
    xp: number
    trackers: {
        time: number
        distanceMoved: number
        airTime: number
        jumps: number
        wallJumps: number
        fallDistance: number
        wallSlideDistance: number
        shotsFired: number
        damageDealt: number
        damagetaken: number
        damageAbsorbed: number
        lootboxesOpened: number
    },
    achievements: string[],
    infractions: [string, number][]
}

interface FileDatabaseAccount extends AccountData {
    readonly password: string
}