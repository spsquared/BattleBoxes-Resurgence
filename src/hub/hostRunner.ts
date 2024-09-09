import { randomUUID as randomSecureUUID } from 'crypto';
import { resolve as pathResolve } from 'path';
import { Namespace as SocketIONamespace, Server as SocketIOServer } from 'socket.io';
import { MessagePort, Worker } from 'worker_threads';

import config from '@/common/config';
import Logger, { MessageChannelLoggerReciever, NamedLogger } from '@/common/log';
import { MessageChannelEventEmitter } from '@/common/messageChannelEvents';

import { AccountOpResult, Database } from '../common/database';

/**
 * Game room manager that creates `GameHost` instances for each room created.
 */
export class GameHostManager {
    readonly io: SocketIOServer;
    readonly db: Database;
    private readonly logger: NamedLogger;
    private readonly hosts: Map<string, GameHostRunner> = new Map();

    /**
     * @param {SocketIOServer} io Socket.IO server
     * @param {Database} db Database connection
     * @param {Logger} logger Logger instance
     */
    constructor(io: SocketIOServer, db: Database, logger: Logger) {
        this.io = io;
        this.db = db;
        this.logger = new NamedLogger(logger, 'GameHostManager');
    }

    /**
     * Fetch a list of all hosts, returning only joinable (in lobby) games if requested.
     * @returns {GameHostRunner[]} Array of hosts
     */
    getHosts(onlyJoinable: boolean = false): GameHostRunner[] {
        const list = Array.from(this.hosts.values());
        if (onlyJoinable) return list.filter((host) => !host.active);
        return list;
    }

    /**
     * Create a new game host (by a player) (with optional settings) and add it to the game list.
     * @param {string} username Username of game creator (checks for validity)
     * @param {{ maxPlayers?: number, aiPlayers?: number }} options Game options (default 8 players, 2 AI players)
     * @returns {GameHostRunner} New host, with specified options
     */
    createGame(username: string, options?: Partial<GameHostOptions>): GameHostRunner {
        const runner = new GameHostRunner(this.io, this.db, username, {
            maxPlayers: 8,
            aiPlayers: 2,
            ...options
        }, this.logger.logger);
        this.hosts.set(runner.id, runner);
        runner.onended(() => this.hosts.delete(runner.id));
        return runner;
    }

    /**
     * Fetch a game host by its id.
     * @param {string} id Id of the game host to find
     * @returns {GameHostRunner | undefined} Game host or undefined if not found
     */
    getGame(id: string): GameHostRunner | undefined {
        return this.hosts.get(id);
    }

    /**
     * End a game by its unique ID, returning true if a game was found and ended (otherwise false).
     * @param {string} id ID of the game host to terminate
     * @returns {boolean} Success status
     */
    endGame(id: string): boolean {
        const runner = this.hosts.get(id);
        if (runner == undefined) return false;
        runner.end();
        this.hosts.delete(id);
        return true;
    }
}

export interface GameHostOptions {
    /**The maximum amount of players in the game - includes AI players */
    readonly maxPlayers: number
    /**The amount of AI agents to spawn in the game */
    readonly aiPlayers: number
}

/**
 * Room runner that spawns a game subprocess and handles communication with it using `postMessage` events.
 */
export class GameHostRunner {
    private static readonly gameIds: Set<string> = new Set();

    readonly id: string;
    private readonly worker: Worker;
    private readonly workerMessenger: MessageChannelEventEmitter;
    private readonly io: SocketIONamespace;
    private readonly db: Database;
    private readonly logger: NamedLogger;
    private readonly hostLogger: NamedLogger;
    readonly hostUser: string;
    readonly options: GameHostOptions;
    private running: boolean = false;
    private ended: boolean = false;
    private readonly readyPromise: Promise<void>;
    private readonly endListeners: Set<() => any> = new Set();

    private readonly authCodes: Map<string, string> = new Map();

    /**
     * @param {SocketIOServer} io Socket.IO server
     * @param {Database} db Database connection
     * @param {string} hostUsername Username of host player (checks for validity) 
     * @param {GameHostOptions} options Game options (cannot be changed after creation)
     * @param {Logger} logger Logger instance
     */
    constructor(io: SocketIOServer, db: Database, hostUsername: string, options: GameHostOptions, logger: Logger) {
        // make sure no overlapping ids (counter would prevent this but id is used as game join code) (also 2.1 billion possible join codes oof)
        do {
            this.id = Array.from(new Array(6), () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012346789'.charAt(Math.floor(Math.random() * 36))).join('');
        } while (!GameHostRunner.gameIds.has(this.id));
        GameHostRunner.gameIds.add(this.id);
        this.worker = new Worker(pathResolve(config.scriptPath, 'host/host.js'), {
            name: this.id
        });
        this.workerMessenger = new MessageChannelEventEmitter(this.worker);
        this.io = io.of(this.id);
        this.db = db;
        this.logger = new NamedLogger(logger, 'GameHostRunner-' + this.id);
        this.hostLogger = new NamedLogger(logger, 'HostThread-' + this.id);
        this.hostUser = hostUsername;
        this.options = options;
        // if this ever goes, there is an uh oh crash
        this.workerMessenger.on('workererror', (err: Error) => {
            this.hostLogger.handleFatal('Host thread terminated: ', err);
        });
        this.workerMessenger.on('error', (err: Error) => {
            this.hostLogger.handleError('MessagePort error:', err);
        });
        this.workerMessenger.on('close', (code: number) => {
            if (code == 0) this.hostLogger.info('Host thread exited');
            else this.hostLogger.fatal('Host thread exited with non-zero exit code ' + code);
        });
        this.readyPromise = new Promise((resolve) => this.worker.on('online', () => resolve()));
        this.readyPromise.then(() => this.logger.info('Host thread online'));
        // more loggers
        this.workerMessenger.once('logger', (loggingPort: MessagePort) => {
            new MessageChannelLoggerReciever(this.hostLogger, loggingPort);
        });
        // also add the host
        this.addPlayer(this.hostUser);
    }

    /**
     * Add a player to the game, returning a verification code the client must use to connect to the game. 
     * @param {string} username Username of player (checks for validity)
     * @returns {Promise<string | null>} Verification code, or null if player does not actually exist
     */
    async addPlayer(username: string): Promise<string | AccountOpResult> {
        const userData = await this.db.getAccountData(username);
        if (typeof userData != 'object') return userData;
        this.workerMessenger.emit('playerJoin', userData);
        const authCode = randomSecureUUID();
        this.authCodes.set(authCode, username);
        return authCode;
    }

    /**
     * Kick a player from the game, returning if a player was kicked.
     * @param {stirng} username Username of player
     * @returns {Promise<boolean>} If a player was kicked
     */
    async kickPlayer(username: string): Promise<boolean> {
        throw new Error('Not implemented');
    }

    /**
     * If the underlying host thread is ready
     */
    get ready(): Promise<void> {
        return this.readyPromise;
    }

    /**
     * If the game is in the lobby and is joinable.
     */
    get active() {
        return this.running;
    }

    /**
     * If the game has finished and is no longer running at all (clients are on leaderboards).
     */
    get finished() {
        return this.ended;
    }

    onended(cb: () => any) {
        this.endListeners.add(cb);
    }

    /**
     * Safely ends the game. Calling `end()` on a game that already ended will not do anything.
     */
    end() {
        GameHostRunner.gameIds.delete(this.id);
        this.endListeners.forEach((cb) => cb());
    }
}