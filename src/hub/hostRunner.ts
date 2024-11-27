import { randomUUID as randomSecureUUID } from 'crypto';
import { resolve as pathResolve } from 'path';
import { Namespace as SocketIONamespace, Server as SocketIOServer, Socket as SocketIOSocket } from 'socket.io';
import { MessagePort, Worker } from 'worker_threads';

import Logger, { MessageChannelLoggerReciever, NamedLogger } from '@/common/log';
import { MessageChannelEventEmitter } from '@/common/messageChannelEvents';
import config from '@/config';

import { AccountData, AccountOpResult, Database } from '../common/database';
import { reverse_enum } from '@/common/util';

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
    getGames(onlyJoinable: boolean = false): GameHostRunner[] {
        const list = Array.from(this.hosts.values());
        if (onlyJoinable) return list.filter((host) => host.joinable);
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
            maxPlayers: options?.maxPlayers ?? 8,
            aiPlayers: options?.aiPlayers ?? 2,
            public: options?.public ?? true
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
     * @returns {Promise<boolean>} Success status
     */
    async endGame(id: string): Promise<boolean> {
        const runner = this.hosts.get(id);
        if (runner == undefined) return false;
        await runner.end();
        this.hosts.delete(id);
        return true;
    }
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
    private readonly chatLogger: NamedLogger;
    private readonly players: Map<string, SocketIOSocket> = new Map();
    hostUser: string;
    readonly options: GameHostOptions;
    private gameRunning: boolean = false;
    private inLobby: boolean = true;
    private readonly readyPromise: Promise<void>;
    private readonly endListeners: Set<(error?: boolean) => any> = new Set();

    private static readonly existingPlayers: Set<string> = new Set();

    private readonly authCodes: Map<string, string> = new Map();
    private readonly playersReady: Set<string> = new Set();

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
            this.id = Array.from(new Array(6), () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(Math.floor(Math.random() * 36))).join('');
        } while (GameHostRunner.gameIds.has(this.id));
        GameHostRunner.gameIds.add(this.id);
        const start = performance.now();
        this.io = io.of(this.id);
        this.db = db;
        this.logger = new NamedLogger(logger, 'GameHostRunner-' + this.id);
        this.hostLogger = new NamedLogger(logger, 'HostThread-' + this.id);
        this.chatLogger = new NamedLogger(logger, 'Chat-' + this.id);
        this.hostUser = hostUsername;
        this.options = options;
        this.logger.info('Creating host thread');
        if (config.debugMode) this.logger.debug(`config: ${JSON.stringify(options)}; host: ${this.hostUser}`, true);
        this.worker = new Worker(pathResolve(config.scriptPath, 'host/host.js'), {
            name: this.id,
            workerData: config
        });
        this.workerMessenger = new MessageChannelEventEmitter(this.worker);
        // if this ever goes, there is an uh oh crash
        this.workerMessenger.on('workererror', (err: Error) => {
            this.logger.handleFatal('Host thread terminated: ', err);
            this.handleEnd(true);
        });
        this.workerMessenger.on('error', (err: Error) => {
            this.logger.handleError('MessagePort error:', err);
        });
        this.workerMessenger.on('close', (code: number) => {
            if (code == 0) this.logger.info('Host thread exited');
            else this.logger.fatal('Host thread exited with non-zero exit code ' + code);
            this.handleEnd(code != 0);
        });
        // set up logger and ready synchronizer promise (apparently Promise.all() returns void array???)
        this.readyPromise = new Promise((resolve) => Promise.race([
            Promise.all<void>([
                new Promise<void>((resolve) => {
                    this.workerMessenger.once('ready', () => {
                        resolve();
                        this.logger.info('Host thread online');
                        if (config.debugMode) this.logger.debug(`Host startup took ${performance.now() - start}ms`, true);
                    });
                }),
                new Promise<void>((resolve) => {
                    this.workerMessenger.once('logger', async (loggingPort: MessagePort) => {
                        const newLogger = new MessageChannelLoggerReciever(this.hostLogger, loggingPort);
                        await newLogger.ready;
                        resolve();
                    });
                })
            ]).then(() => resolve()),
            new Promise<void>((resolve) => {
                this.workerMessenger.on('workererror', () => resolve());
                this.workerMessenger.on('close', () => resolve());
            })
        ]));
        // socket.io handoff
        this.io.on('connection', (socket) => this.handlePlayerConnection(socket));
        this.initServerEvents();
    }

    /**
     * Add a player to the game, returning a verification code the client must use to connect to the game. 
     * @param {string} username Username of player (checks for validity)
     * @returns {Promise<string | null>} Verification code, or null if player does not actually exist
     */
    async addPlayer(username: string): Promise<string | AccountOpResult> {
        this.logger.info(`Adding ${username} to game`, true);
        if (this.players.has(username)) {
            this.logger.info('Could not add player due to already being in game');
            return AccountOpResult.ALREADY_EXISTS;
        }
        if (GameHostRunner.existingPlayers.has(username)) {
            this.logger.info('Could not add player due to already being in other game');
            return AccountOpResult.ALREADY_EXISTS;
        }
        const userData = await this.db.getAccountData(username);
        if (typeof userData != 'object') {
            this.logger.error('Could not add player due to database error: ' + reverse_enum(AccountOpResult, userData))
            return userData;
        }
        await this.readyPromise;
        this.workerMessenger.emit('playerJoin', userData);
        // authentication codes will eventually time out to prevent an easy DOS by spamming joins
        const authCode = randomSecureUUID();
        this.authCodes.set(authCode, username);
        if (config.debugMode) this.logger.debug(`Authentication code "${authCode}" generated for ${username}`, true);
        setTimeout(() => {
            if (this.authCodes.has(authCode)) {
                this.logger.warn(`Authentication code "${authCode}" was not used and timed out after ${config.gameConnectTimeout}s`);
                this.authCodes.delete(authCode);
                this.workerMessenger.emit('playerLeave', username);
            }
        }, config.gameConnectTimeout * 1000);
        this.broadcastGameInfo();
        return authCode;
    }

    /**
     * Remove a player from the game (with optional reason), returning if a player was removed.
     * @param {string} username Username of player
     * @param {string | undefined} reason Reason (usually for kicks)
     * @returns {Promise<boolean>} If a player was removed
     */
    async removePlayer(username: string, reason?: string): Promise<boolean> {
        const socket = this.players.get(username);
        if (socket == undefined) return false;
        if (reason != undefined) this.logger.info(`${username} removed from game for ${reason}`);
        else if (config.debugMode) this.logger.debug(`${username} left the game`);
        this.players.delete(username);
        GameHostRunner.existingPlayers.delete(username);
        this.playersReady.delete(username);
        socket.emit('leave', reason);
        socket.disconnect();
        this.workerMessenger.emit('playerLeave', username, reason);
        this.broadcastGameInfo();
        return true;
    }

    /**
     * The total number of players, excluding AI players.
     */
    get playerCount(): number {
        return this.players.size;
    }

    /**
     * Game information as presented on clients.
     */
    get gameInfo(): GameInfo {
        return {
            ...this.options,
            id: this.id,
            host: this.hostUser,
            players: this.playerCount,
            playersReady: this.playersReady.size,
            running: this.gameRunning
        };
    }

    /**
     * Initializes events for communication with the Worker thread and global Socket.IO.
     * Should only ever be called once!
     */
    private async initServerEvents(): Promise<void> {
        this.workerMessenger.on('tick', (tickDat) => this.io.emit('tick', tickDat));
        this.workerMessenger.on('kick', (username: string, reason: string) => this.removePlayer(username, reason));
        this.workerMessenger.on('playerData', async (data: AccountData) => {
            const res = await this.db.updateAccountData(data);
            if (res != AccountOpResult.SUCCESS) this.logger.error('Failed to save player data: ' + reverse_enum(AccountOpResult, res));
        });
        this.workerMessenger.on('chatMessage', (message: ChatMessageSection | ChatMessageSection[]) => this.sendChatMessage(message));
        this.workerMessenger.on('privateMessage', (message: ChatMessageSection | ChatMessageSection[], target: string) => this.sendPrivateMessage(message, target));
        this.workerMessenger.on('gameStart', () => {
            this.gameRunning = true;
            this.inLobby = false;
            this.broadcastGameInfo();
        });
        this.workerMessenger.on('gameEnd', () => {
            this.gameRunning = false;
            this.broadcastGameInfo();
            this.io.emit('gameEnd');
        });
    }

    /**
     * Handles incoming Socket.IO connection by a client. Does authentication and adds listeners.
     * @param s New Socket.IO connection
     */
    private async handlePlayerConnection(s: SocketIOSocket): Promise<void> {
        const socket = s;
        if (config.debugMode) this.logger.debug(`Incoming Socket.IO connection from ${socket.handshake.address}\n  Auth: ${JSON.stringify(socket.handshake.auth)}`, true);
        if (socket.handshake.auth == undefined || typeof socket.handshake.auth.token != 'string') {
            this.logger.warn(`'Socket.IO connection with no authentication from ${socket.handshake.address} was blocked`);
            socket.disconnect();
            return;
        }
        const username = this.authCodes.get(socket.handshake.auth.token);
        this.authCodes.delete(socket.handshake.auth.token);
        if (username == undefined) {
            this.logger.warn(`'Socket.IO connection with bad authentication from ${socket.handshake.address} was blocked`);
            socket.disconnect();
            return;
        }
        if (this.players.has(username)) {
            this.logger.warn('Duplicate player attempted to join game: ' + username);
            socket.disconnect();
            return;
        }
        if (GameHostRunner.existingPlayers.has(username)) {
            this.logger.warn('Player attempted to join game while in another game: ' + username);
            socket.disconnect();
            return;
        }
        GameHostRunner.existingPlayers.add(username);
        socket.join(username);
        this.players.set(username, socket);
        if (config.debugMode) this.logger.debug(`${username} connected`);
        this.broadcastGameInfo();

        // not this time!!!
        socket.on('error', () => {
            this.logger.warn(`${username} disconnected for "error" event`);
            socket.disconnect();
        });

        // forward events
        const sendEvents: string[] = ['pong', 'initPlayerPhysics'];
        const receiveEvents: string[] = ['ping', 'ready', 'tick', 'chatMessage', 'readyStart'];
        for (const ev of sendEvents) {
            this.workerMessenger.on(`${username}/${ev}`, (...data: any[]) => socket.emit(ev, ...data));
        }
        for (const ev of receiveEvents) {
            const map = `${username}/${ev}`;
            socket.on(ev, (...data: any[]) => this.workerMessenger.emit(map, ...data));
        }
        socket.on('readyStart', (ready: boolean) => {
            if (ready) this.playersReady.add(username);
            else this.playersReady.delete(username);
            this.broadcastGameInfo();
        });
        // removing listeners
        socket.on('disconnect', () => {
            this.removePlayer(username);
            socket.removeAllListeners();
        });

        // notify host of connection completion
        this.workerMessenger.emit('playerConnect', username);
    }

    private broadcastGameInfo(): void {
        this.io.emit('gameInfo', this.gameInfo);
    }

    /**
     * Sends a message in public chat.
     * @param message Single message text section or list of sections
     */
    sendChatMessage(message: ChatMessageSection | ChatMessageSection[]): void {
        const sections = Array.isArray(message) ? message : [message];
        this.io.emit('chatMessage', sections);
        this.chatLogger.info(sections.reduce((p, c) => p + c.text, ''), true);
    }

    /**
     * Sends a message in private chat to a specific player. Does not verify that the recipient exists.
     * @param message Single message text section or list of sections
     * @param target Username of recipient player
     */
    sendPrivateMessage(message: ChatMessageSection | ChatMessageSection[], target: string): void {
        const sections = Array.isArray(message) ? message : [message];
        this.io.emit('chatMessage', sections);
        this.chatLogger.info(`[PM -> ${target}] ${sections.reduce((p, c) => p + c.text, '')}`, true);
    }

    /**
     * If the underlying host thread is ready
     */
    get ready(): Promise<void> {
        return this.readyPromise;
    }

    /**
     * If the game is active (not in lobby and not ended).
     */
    get running(): boolean {
        return this.gameRunning;
    }

    /**
     * If the game is currently joinable (in lobby).
     */
    get joinable(): boolean {
        return this.inLobby;
    }

    /**
     * Add a listener for the game end.
     * @param cb Callback function with `error` parameter (if an error caused the game to end)
     */
    onended(cb: (error?: boolean) => any): void {
        this.endListeners.add(cb);
    }

    /**
     * Safely ends the game. Calling `end()` on a game that already ended will not do anything.
     */
    async end(): Promise<void> {
        this.logger.info('Game end triggered externally', true);
        const start = performance.now();
        await new Promise<void>((resolve) => {
            this.workerMessenger.emit('shutdown');
            this.workerMessenger.on('close', () => resolve());
        });
        this.handleEnd(false);
        if (config.debugMode) this.logger.debug(`Host shutdown took ${performance.now() - start}ms`, true);
    }

    /**
     * Shuts down the game.
     * @param error If an error caused the shutdown
     */
    private handleEnd(error: boolean) {
        this.io.disconnectSockets();
        GameHostRunner.gameIds.delete(this.id);
        this.endListeners.forEach((cb) => { try { cb(error) } catch (err) { this.logger.handleError('Error in end listener:', err); } });
    }
}

/**User-configurable options for a game */
export interface GameHostOptions {
    /**The maximum amount of players in the game - includes AI players */
    readonly maxPlayers: number
    /**The amount of AI agents to spawn in the game */
    readonly aiPlayers: number
    /**Allow players to join through a public join list */
    readonly public: boolean
}

/**Information for client display of a game */
export interface GameInfo extends GameHostOptions {
    /**ID of game */
    readonly id: string
    /**Username of the host player */
    readonly host: string
    /**The number of players connected */
    readonly players: number
    /**The number of players ready for game start */
    readonly playersReady: number
    /**If the game is active (not in lobby and not ended) */
    readonly running: boolean
}

/**Describes a single section of a chat message */
export interface ChatMessageSection {
    /**Text, will be interpreted as text and not HTML on clients (unless `trusted` is `true`) */
    text: string
    /**Optional text styling options */
    style?: {
        color?: string,
        fontWeight?: 'normal' | 'bold',
        fontStyle?: 'normal' | 'italic'
    }
    /**Allows HTML contents in `test` */
    trusted?: boolean
}

export default GameHostManager;