import type { AccountData } from '@/common/database';
import { validateStructure } from '@/common/inputValidation';
import { NamedLogger } from '@/common/log';

import Entity from './entities/entity';
import Player, { PlayerTickInput } from './entities/player';
import { logger, parentMessenger, stopServer } from './host';
import GameMap from './map';

/**
 * Handles core game logic like points, rounds, and ticking.
 */
export class Game {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'Game');
    private static running: boolean = true;
    private static runStart: number = 0;
    /**Lobby mode enables respawning and disables statistic trackers and points */
    private static lobbyMode: boolean = true;

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
            this.perfMetrics.tpsTimes.push(start);
            this.perfMetrics.tpsHist.push(this.perfMetrics.tpsTimes.length);
            this.perfMetrics.tickTimes.push(end - start);
            while (this.perfMetrics.tpsTimes[0] <= end - 1000) {
                this.perfMetrics.tpsTimes.shift();
                this.perfMetrics.tpsHist.shift();
                this.perfMetrics.tickTimes.shift();
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 25 - end + start));
        }
    }

    /**
     * Ticks and sends update packet to clients.
     */
    private static lastTpsWarning = 0;
    private static tick(): void {
        const metrics = this.metrics;
        if (metrics.tps.avg < 30 && performance.now() > this.runStart + 2000) {
            if (this.lastTpsWarning < performance.now() - 60000) {
                this.logger.warn(`Low tickrate! Is the server overloaded? Current performance metrics:\n${JSON.stringify(metrics, null, 2)}`);
            }
            this.lastTpsWarning = performance.now();
        }
        Entity.nextTick();
        parentMessenger.emit('tick', {
            tick: Entity.tick,
            tps: metrics.tps.curr,
            map: GameMap.current?.name ?? '',
            players: Player.nextTick()
        });
    }

    /**
     * Add a new player.
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
                inputs: { left: false, right: false, up: false, down: false }
            })) {
                player.kick('malformed_tick_packet');
                return;
            }
            player.physicsTick(packet);
        };
        parentMessenger.on(player.username + '/tick', onPhysicsTick);
        player.onRemoved(() => {
            parentMessenger.off(player.username + '/tick', onPhysicsTick);
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
            if (reason != undefined) {
                parentMessenger.emit('kick', username, reason);
                this.logger.warn(`Kicked ${username}: ${reason}`);
            }
            this.logger.info(`Removed ${username} from game`);
            // close the game if there's not enough players
            if (Player.list.size < 2) setTimeout(() => this.stop('Not enough players'));
        } else this.logger.warn(`Could not remove ${username} from game as player is not in game`);
    }

    /**
     * Starts the game immediately.
     */
    static start(): void {
        this.startTickLoop();
    }

    /**
     * Safely ends the game and saves player statistics.
     * @param reason Reason for game end
     */
    static async stop(reason: string): Promise<void> {
        if (!this.running) return;
        this.running = false;
        this.logger.info(`Game was stopped: ${reason}`);
        Player.list.forEach((player) => player.remove());
        stopServer(0);
    }

    /**
     * Contains performance metrics regarding server tickrate and timings.
     */
    static get metrics() {
        return {
            tps: {
                curr: this.perfMetrics.tpsTimes.length,
                avg: this.perfMetrics.tpsHist.reduce((p, c) => p + c, 0) / this.perfMetrics.tpsHist.length,
                max: Math.max(...this.perfMetrics.tpsHist),
                min: Math.min(...this.perfMetrics.tpsHist)
            },
            timings: {
                avg: this.perfMetrics.tickTimes.reduce((p, c) => p + c, 0) / this.perfMetrics.tickTimes.length,
                max: Math.max(...this.perfMetrics.tickTimes),
                min: Math.min(...this.perfMetrics.tickTimes)
            }
        }
    }
}

// events from socketio
parentMessenger.on('playerJoin', (user: AccountData) => Game.addPlayer(user));
parentMessenger.on('playerLeave', (username: string, reason?: string) => Game.removePlayer(username, reason));
parentMessenger.on('playerConnect', (username: string) => {
    parentMessenger.emit(username + '/initPlayerPhysics', {
        tick: Entity.tick,
        physicsResolution: Entity.physicsResolution,
        playerProperties: Player.baseProperties
    });
    const player = Player.list.get(username);
    if (player !== undefined) {
        player.connected = true;
        player.toRandomSpawnpoint();
    }
});

// load maps immediately and start ticking
GameMap.reloadMaps().then(() => GameMap.current = GameMap.maps.get('lobby'));
Game.startTickLoop();

export default Game;