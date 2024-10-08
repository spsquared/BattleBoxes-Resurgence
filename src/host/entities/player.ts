import type { AccountData } from '@/common/database';
import { validateStructure } from '@/common/inputValidation';

import { Entity, EntityTickData } from './entity';
import { Game } from '../game';
import { NamedLogger } from '@/common/log';
import { logger } from '../host';

export class Player extends Entity {
    static readonly list: Map<string, Player> = new Map();

    readonly logger: NamedLogger;
    readonly username: string;
    readonly accountData: AccountData;
    readonly clientPhysics: {
        /** */
        tick: number,
        badTickInfractions: number
        fastTickInfractions: number
    } = {
            tick: 0,
            badTickInfractions: 0,
            fastTickInfractions: 0
        };
    readonly effects: { id: number, effect: Modifiers, length: number }[] = [];

    private static readonly baseGravity = 8;
    private static readonly baseMovePower = 10;
    private static readonly baseJumpPower = 20;
    private static readonly baseDrag = 0.98;
    private static readonly baseWallGrip = 0.2;
    gravity = Player.baseGravity;
    movePower = Player.baseMovePower;
    jumpPower = Player.baseJumpPower;
    drag = Player.baseDrag;
    wallGrip = Player.baseWallGrip;

    private static readonly colorList = ['#F00', '#F90', '#0F0', '#0FC', '#09F', '#00F', '#90F', '#F0F'];
    private static readonly usedColors: Set<string> = new Set();
    readonly color: string;

    constructor(data: AccountData) {
        super(0, 0, 48, 48);
        this.username = data.username;
        this.logger = new NamedLogger(logger, this.username);
        this.accountData = data;
        this.color = Player.colorList.find((c) => !Player.usedColors.has(c)) ?? '#A07';
        Player.usedColors.add(this.color);
        if (Player.list.has(this.username)) throw new Error(`Duplicate Player "${this.username}"!`);
        Player.list.set(this.username, this);
    }

    tick() {
        // apply effects and loot boxes and stuff
        // check for missed ticks and other infractions
    }

    /**
     * Player-unique tick function that runs when the client sends its physics tick to the server.
     * Validates the physics tick by running it on the same conditions
     * @param packet Client tick packet
     */
    clientTick(packet: PlayerTickInput): void {
        // input validation
        if (!validateStructure<PlayerTickInput>(packet, {
            tick: 0,
            startx: 0,
            starty: 0,
            endx: 0,
            endy: 0,
            modifiers: [0],
            inputs: { left: false, right: false, up: false, down: false }
        })) {
            this.kick('Malformed tick packet');
            return;
        }
        // tick simulation and validation

    }

    get tickData(): PlayerTickData {
        return {
            ...super.tickData,
            username: this.username,
            color: this.color,
            contactEdges: this.contactEdges
        };
    }

    /**
     * Kick the player from the game. Usually used for anticheat.
     * @param reason Kick reason
     */
    kick(reason: string) {
        const existing = this.accountData.infractions.find((([r]) => r === reason));
        if (existing) existing[1]++;
        else this.accountData.infractions.push([reason, 1]);
        this.removeListeners.forEach((cb) => { try { cb(reason); } catch (err) { this.logger.handleError('Error in Player remove listener:', err); } });
        this.removeListeners.clear();
        Game.removePlayer(this.username, reason);
        this.remove();
    }

    private readonly removeListeners: Set<(reason?: string) => any> = new Set();
    /**
     * Add a listener for when the player is removed from the game.
     * @param cb Callback function with argument for removal reason (`undefined` if not removed by kick)
     */
    onRemoved(cb: (reason?: string) => any) {
        this.removeListeners.add(cb);
    }
    /**
     * Remove the player from the game.
     */
    remove() {
        super.remove();
        Player.usedColors.delete(this.color);
        const removed = !Player.list.has(this.username);
        Player.list.delete(this.username);
        this.removeListeners.forEach((cb) => { try { cb(); } catch (err) { this.logger.handleError('Error in Player remove listener:', err); } });
        this.removeListeners.clear();
        if (!removed) Game.removePlayer(this.username);
    }

    /**
     * Advances all players to the next tick.
     * @returns Player tick data for clients
     */
    static nextTick(): PlayerTickData[] {
        return Array.from(Player.list, ([username, player]) => {
            player.tick();
            return player.tickData;
        });
    }
}

/**
 * A packet representing a client physics tick, to be cross-checked by the server to minimize cheating.
 * The server runs the same tick to make sure movement physics are unmodified and effect timers are correct.
 */
export interface PlayerTickInput {
    /**Client tick number, not strictly linked to server tickrate */
    readonly tick: number
    /**Starting X coordinate for tick */
    readonly startx: number
    /**Starting Y coordinate for tick */
    readonly starty: number
    /**Ending X coordinate for tick */
    readonly endx: number
    /**Ending Y coordinate for tick */
    readonly endy: number
    /**List of modifier ID list for cross-checking with server */
    readonly modifiers: number[]
    /**All inputs being held for that tick */
    readonly inputs: {
        readonly left: boolean
        readonly right: boolean
        readonly up: boolean
        readonly down: boolean
    }
}

export interface PlayerTickData extends EntityTickData {
    readonly username: string
    readonly color: string
    readonly contactEdges: Entity['contactEdges']
}

export enum Modifiers {
    /**Makes you faaaast */
    MOVE_POWER,
    /**Makes you faaaast faster */
    MOVE_DRAG,
    /**Makes you jump higher */
    JUMP_POWER,
    /**Allows you to completely stop on walls by pressing down */
    WALL_GRIP
}