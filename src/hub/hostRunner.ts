import { Server as SocketIOServer, Namespace as SocketIONamespace } from 'socket.io';
import { randomUUID as randomSecureUUID } from 'crypto';
import { Database } from './database';
import Logger, { NamedLogger } from '@/log';

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
        return runner;
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
    private readonly io: SocketIONamespace;
    private readonly db: Database;
    private readonly logger: NamedLogger;
    readonly host: string;
    readonly options: GameHostOptions;
    private running: boolean = false;
    private ended: boolean = false;

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
        this.io = io.of(this.id);
        this.db = db;
        this.logger = new NamedLogger(logger, 'GameHostRunner-' + this.id);
        this.host = hostUsername;
        this.options = options;
        this.addPlayer(this.host);
    }

    /**
     * Add a player to the game, returning a verification code the client must use to connect to the game. 
     * @param {string} username Username of player (checks for validity)
     * @returns {string} Verification code
     */
    addPlayer(username: string): string {
        // fetch the player data and send to subprocess
        return randomSecureUUID();
    }

    /**
     * Kick a player from the game, returning if a player was kicked.
     * @param {stirng} username Username of player
     * @returns {boolean} If a player was kicked
     */
    kickPlayer(username: string): boolean {
        throw new Error('Not implemented');
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

    /**
     * Safely ends the game. Calling `end()` on a game that already ended will not do anything.
     */
    end() {

    }
}