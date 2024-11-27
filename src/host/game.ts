import type { AccountData } from '@/common/database';
import { doesContainBadWords, preprocessWordLists, textToLatin, unEmoji } from 'deep-profanity-filter';

import { validateStructure } from '@/common/inputValidation';
import { NamedLogger } from '@/common/log';
import config from '@/config';

import Entity from './entities/entity';
import LootBox from './entities/lootbox';
import Player, { PlayerTickInput } from './entities/player';
import Projectile from './entities/projectile';
import { logger, parentMessenger, stopServer } from './host';
import GameMap from './map';

import type { ChatMessageSection } from '@/hub/hostRunner';

/**
 * Handles core game logic like points, rounds, and ticking.
 */
export class Game {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'Game');

    static readonly profanityFilter = preprocessWordLists([...config.chatBannedWordList, 'gackie', 'gacky'], [], { checkCircumventions: true });
    private static readonly targetTps = 40;
    private static readonly tickTiming = 1000 / Game.targetTps;
    private static running: boolean = true;
    private static runStart: number = 0;
    /**Lobby mode enables respawning and disables statistic trackers and points */
    static lobbyMode: boolean = true;

    private static readonly perfMetrics: {
        tpsTimes: number[]
        tpsHist: number[]
        tickTimes: number[]
    } = {
            tpsTimes: [],
            tpsHist: [],
            tickTimes: []
        };

    /**
     * Starts ticking, will not end until {@link stop} is called.
     */
    static async startTickLoop(): Promise<void> {
        this.runStart = performance.now();
        while (this.running) {
            const start = performance.now();
            this.tick();
            const end = performance.now();
            // use tick start time so 0tps is actually reportable
            this.perfMetrics.tpsTimes.push(start);
            while (this.perfMetrics.tpsTimes[0] <= end - 1000) {
                this.perfMetrics.tpsTimes.shift();
                this.perfMetrics.tpsHist.shift();
                this.perfMetrics.tickTimes.shift();
            }
            this.perfMetrics.tpsHist.push(this.perfMetrics.tpsTimes.length);
            this.perfMetrics.tickTimes.push(end - start);
            await new Promise<void>((resolve) => setTimeout(resolve, this.tickTiming - end + start));
        }
    }

    /**
     * Ticks and sends update packet to clients.
     */
    private static lastTpsWarning = 0;
    private static tick(): void {
        const metrics = this.metrics;
        if (performance.now() > this.runStart + 2000) {
            if (metrics.tps.avg < 30) {
                if (this.lastTpsWarning < performance.now() - 60000) {
                    this.logger.warn(`Low tickrate! Is the server overloaded? TPS: ${metrics.tps.curr}/${metrics.tps.avg} Jitter: ${metrics.tps.jitter}`);
                    this.logger.warn(`  Current performance metrics:\n${JSON.stringify(metrics, null, 2)}`, true);
                }
                this.lastTpsWarning = performance.now();
            }
            if (metrics.tps.jitter > 5) {
                if (this.lastTpsWarning < performance.now() - 60000) {
                    this.logger.warn(`Unstable tickrate! Is the server overloaded? TPS: ${metrics.tps.curr}/${metrics.tps.avg} Jitter: ${metrics.tps.jitter}`);
                    this.logger.warn(`  Current performance metrics:\n${JSON.stringify(metrics, null, 2)}`, true);
                }
                this.lastTpsWarning = performance.now();
            }
        }
        Entity.nextTick();
        parentMessenger.emit('tick', {
            tick: Entity.tick,
            tps: metrics.tps,
            timings: metrics.timings,
            heapUsed: metrics.heap.used,
            heapTotal: metrics.heap.total,
            map: GameMap.current?.id ?? '',
            players: Player.nextTick(),
            projectiles: Projectile.nextTick(),
            lootboxes: LootBox.nextTick()
        });
    }

    /**
     * Add a new player. Contains handlers for incoming packets and chat.
     * @param user User data to initialize player with
     */
    static addPlayer(user: AccountData): void {
        const player = new Player(user);
        this.logger.info(`Added ${player.username} to game`);
        // player inputs
        const onPhysicsTick = (packet: PlayerTickInput) => {
            if (!validateStructure<PlayerTickInput>(packet, {
                tick: 0,
                modifiers: [0],
                inputs: { left: false, right: false, up: false, down: false, primary: false, secondary: false, mouseAngle: 0 },
                position: { endx: 0, endy: 0 }
            })) {
                player.kick('malformed_tick_packet');
                return;
            }
            player.physicsTick(packet);
        };
        parentMessenger.on(player.username + '/tick', onPhysicsTick);
        // ping
        const pingName = player.username + '/pong';
        const ping = (t: number) => parentMessenger.emit(pingName, t);
        parentMessenger.on(player.username + '/ping', ping);
        // chat
        const chatInfractions = {
            spam: 0,
            profanity: 0,
            lastMessage: 0,
            decrementer: setInterval(() => {
                chatInfractions.spam = 0;
                chatInfractions.profanity = 0;
            }, 60000)
        };
        // ready button
        parentMessenger.on(player.username + '/readyStart', (ready: boolean) => {
            player.ready = ready && true || false; // converts to boolean
            let readyCount = 0;
            for (const player of Player.list.values()) {
                if (player.ready) readyCount++;
            }
            if (readyCount >= Math.max(this.minPlayersReady, Player.list.size) && !this.gameRunning) {
                this.start();
            }
        });
        // allow consecutive violation so "oh... buh" doesnt cause ban
        const onChatMessage = (message: string) => {
            if (typeof message != 'string' || message.length > 128 || message.length < 1) {
                player.kick('malformed_chat_message');
                return;
            }
            // very words
            const now = performance.now();
            if (now - chatInfractions.lastMessage < config.chatMinMillisPerMessage) {
                chatInfractions.spam++;
                if (chatInfractions.spam > config.chatSpamGraceCount) this.sendPrivateMessage([
                    {
                        text: 'Slow down! ',
                        style: { fontStyle: 'italic', color: '#F00' }
                    },
                    {
                        text: 'Your typing is too fast!',
                        style: { fontStyle: 'italic' }
                    }
                ], player.username);
            }
            chatInfractions.lastMessage = now;
            const latinatedMessage = textToLatin(unEmoji(message));
            if (doesContainBadWords(latinatedMessage, this.profanityFilter)) {
                chatInfractions.profanity++;
                this.sendPrivateMessage({
                    text: 'Chat message redacted for profanity',
                    style: { fontStyle: 'italic', color: '#F00' }
                }, player.username);
            } else {
                this.sendChatMessage([
                    {
                        text: player.username + ': ',
                        style: { fontWeight: 'bold', color: player.color }
                    },
                    {
                        text: latinatedMessage
                    }
                ]);
            }
            if (Math.max(0, chatInfractions.spam - config.chatSpamGraceCount) + chatInfractions.profanity > config.chatMaxSpamPerMinute) {
                player.kick('chat_spam');
            }
        };
        parentMessenger.on(player.username + '/chatMessage', onChatMessage);
        // prevent resource leak by removing listeners
        player.onRemoved(() => {
            parentMessenger.off(player.username + '/tick', onPhysicsTick);
            parentMessenger.off(player.username + '/ping', ping);
            parentMessenger.off(player.username + '/chatMessage', onChatMessage);
            clearInterval(chatInfractions.decrementer);
        });
    }

    /**
     * Remove a player by username (leaving the game), optionally making it a kick by setting `reason`
     * @param username Username of player to remove
     * @param reason Optional reason - if set, removal is treated as a kick
     */
    static removePlayer(username: string, reason?: string): void {
        if (Player.list.has(username)) {
            const player = Player.list.get(username)!;
            Player.list.delete(username);
            player.remove();
            parentMessenger.emit('playerData', player.accountData);
            parentMessenger.removeAllListeners(player.username + '/tick');
            parentMessenger.removeAllListeners(player.username + '/ping');
            parentMessenger.removeAllListeners(player.username + '/readyStart');
            parentMessenger.removeAllListeners(player.username + '/chatMessage');
            if (reason != undefined) {
                parentMessenger.emit('kick', username, reason);
                this.logger.warn(`Kicked ${username}: ${reason}`);
            }
            this.logger.info(`Removed ${username} from game`);
            // close the game if there's not enough players
            if (Player.list.size < (this.lobbyMode ? 1 : 2)) setTimeout(() => this.stop('Not enough players'));
        } else this.logger.warn(`Could not remove ${username} from game as player is not in game`);
    }

    /**
     * Sends a message in public chat.
     * @param message Single message text section or list of sections
     */
    static sendChatMessage(message: ChatMessageSection | ChatMessageSection[]): void {
        parentMessenger.emit('chatMessage', message);
    }

    /**
     * Sends a message in private chat to a specific player. Does not verify that the recipient exists.
     * @param message Single message text section or list of sections
     * @param target Username of recipient player
     */
    static sendPrivateMessage(message: ChatMessageSection | ChatMessageSection[], target: string): void {
        parentMessenger.emit('privateMessage', message, target);
    }

    static readonly minPlayersReady = 1; // SET TO 2!!!!!!!!!!!
    static gameRunning: boolean = false;
    static round: number = 0;

    /**
     * Starts the game immediately.
     */
    static start(): void {
        this.gameRunning = true;
        this.lobbyMode = false;
        parentMessenger.emit('gameStart');
        this.logger.info('Game is starting');
        this.sendChatMessage({ text: 'The game is starting!', style: { color: '#0E0', fontWeight: 'bold' } });
        this.startRound();
    }

    static startRound(): void {
        this.round++;
        // add pool stuff later
        const pool = GameMap.randomPool();
        const map = GameMap.randomMapInPool(pool);
        if (map == undefined) this.logger.warn(`Could not set map from nonexistent pool "${pool}"`);
        const success = GameMap.setMap(map ?? 'lobby');
        if (!success) this.logger.warn(`Failed to set map to "${map}"`);
        Player.spreadPlayers();
        // use effect to freeze players - special countdown effect
    }

    static endRound(): void {

    }

    /**
     * Safely ends the game and saves player statistics.
     * @param reason Reason for game end
     */
    static async stop(reason: string): Promise<void> {
        if (!this.running) return;
        this.running = false;
        parentMessenger.emit('gameEnd');
        this.logger.info(`Game was stopped: ${reason}`);
        this.sendChatMessage([
            { text: 'Game stopped! ', style: { color: '#F00', fontWeight: 'bold' } },
            { text: 'Reason: ' + reason, style: { color: '#F00' } }
        ]);
        Player.list.forEach((player) => player.remove());
        stopServer(0);
    }

    /**
     * Retrieves performance metrics regarding server tickrate and timings.
     */
    static get metrics() {
        const memUsage = process.memoryUsage();
        return {
            tps: {
                curr: this.perfMetrics.tpsTimes.length,
                avg: this.perfMetrics.tpsHist.reduce((p, c) => p + c, 0) / this.perfMetrics.tpsHist.length,
                max: Math.max(...this.perfMetrics.tpsHist),
                min: Math.min(...this.perfMetrics.tpsHist),
                jitter: Math.max(...this.perfMetrics.tpsHist) - Math.min(...this.perfMetrics.tpsHist)
            },
            timings: {
                avg: this.perfMetrics.tickTimes.reduce((p, c) => p + c, 0) / this.perfMetrics.tickTimes.length,
                max: Math.max(...this.perfMetrics.tickTimes),
                min: Math.min(...this.perfMetrics.tickTimes)
            },
            heap: {
                used: memUsage.heapUsed / 1048576,
                total: memUsage.heapTotal / 1048576
            }
        }
    }
}

// events from socketio
// emitted when a player first requests to join the game - Socket.IO connection not yet established
parentMessenger.on('playerJoin', (user: AccountData) => Game.addPlayer(user));
// emitted when a player's Socket.IO connection ends or fails to connect before timing out
parentMessenger.on('playerLeave', (username: string, reason?: string) => Game.removePlayer(username, reason));
// emitted when a player's Socket.IO connection is made (proceeding "ready" connection is acknowledging server "initPlayerPhysics")
parentMessenger.on('playerConnect', (username: string) => {
    parentMessenger.emit(username + '/initPlayerPhysics', {
        tick: Entity.tick,
        physicsResolution: Entity.physicsResolution,
        physicsBuffer: Entity.physicsBuffer,
        playerProperties: Player.baseProperties,
        projectileTypes: Projectile.typeVertices,
        chunkSize: GameMap.chunkSize
    });
    parentMessenger.once(username + '/ready', () => {
        const player = Player.list.get(username);
        if (player !== undefined) {
            player.connected = true;
            player.toRandomSpawnpoint();
            parentMessenger.emit('chatMessage', {
                text: `${player.username} joined the game`,
                style: { fontWeight: 'bold', color: '#FD0' }
            } satisfies ChatMessageSection);
        }
    });
});

// load maps immediately and start ticking
GameMap.reloadMaps().then(() => GameMap.setMap('lobby'));
Game.startTickLoop();

export default Game;