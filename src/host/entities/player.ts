import type { AccountData } from '@/common/database';
import { validateStructure } from '@/common/inputValidation';

import { Entity, EntityTickData } from './entity';
import { Game } from '../game';
import { NamedLogger } from '@/common/log';
import { logger } from '../host';

/**
 * Represents a player controlled by a client. Movement physics is performed by the client and server in
 * lockstep to improve input response times, with server ticking initiated by client physics packets to
 * validate the movement and prevent cheating. Any discrepancy will cause the server to override the client.
 */
export class Player extends Entity {
    static readonly list: Map<string, Player> = new Map();

    private static readonly maxFastTickInfractions = 10;
    private static readonly maxSlowTickInfractions = 20;
    private static readonly maxTickLag = 40;

    readonly logger: NamedLogger;
    readonly username: string;
    readonly accountData: AccountData;
    readonly clientPhysics: {
        /**Tick number the client is on - allows for latency with verification of game logic */
        tick: number,
        /**Number of infractions for physics ticks being ahead of the server */
        fastTickInfractions: number
        /**Number of infractions for physics ticks being too far behind server */
        slowTickInfractions: number
    } = {
            tick: 0,
            fastTickInfractions: 0,
            slowTickInfractions: 0,
        };

    static readonly baseProperties: Readonly<Player['properties']> = {
        gravity: 0,
        movePower: 10,
        jumpPower: 20,
        airMovePower: 0.5,
        drag: 0.99,
        friction: 0.95,
        grip: 0.2
    };
    readonly properties: {
        gravity: number
        movePower: number
        jumpPower: number
        airMovePower: number
        drag: number
        friction: number
        grip: number
    } = {
            gravity: Player.baseProperties.gravity,
            movePower: Player.baseProperties.movePower,
            jumpPower: Player.baseProperties.jumpPower,
            airMovePower: Player.baseProperties.airMovePower,
            drag: Player.baseProperties.drag,
            friction: Player.baseProperties.friction,
            grip: Player.baseProperties.grip
        };
    readonly modifiers: Map<number, { modifier: Modifiers, length: number, activated: boolean }> = new Map();

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
        // check for lootboxes and stuff
        // check for missed ticks and other infractions
        if (this.clientPhysics.tick - Entity.tick > Player.maxTickLag) {
            this.clientPhysics.fastTickInfractions++;
            this.logger.warn(`Client ahead of server ticking by ${this.clientPhysics.tick - Entity.tick} ticks - ${Player.maxFastTickInfractions - this.clientPhysics.fastTickInfractions} violations remain`);
            if (this.clientPhysics.fastTickInfractions > Player.maxFastTickInfractions) {
                this.kick('client_too_fast');
                return;
            }
        } else if (Entity.tick - this.clientPhysics.tick > Player.maxTickLag) {
            this.clientPhysics.slowTickInfractions++;
            this.logger.warn(`Client behind server ticking by ${Entity.tick - this.clientPhysics.tick} ticks - ${Player.maxSlowTickInfractions - this.clientPhysics.slowTickInfractions} violations remain`);
            if (this.clientPhysics.slowTickInfractions > Player.maxSlowTickInfractions) {
                this.kick('client_too_slow');
                return;
            }
        }
    }

    /**
     * Player-unique tick that runs when the client sends its physics tick to the server.
     * Validates the physics tick by running it on the same conditions
     * @param packet Client tick packet
     */
    physicsTick(packet: PlayerTickInput): void {
        // input validation
        if (!validateStructure<PlayerTickInput>(packet, {
            tick: 0,
            modifiers: [0],
            inputs: { left: false, right: false, up: false, down: false }
        })) {
            this.kick('Malformed tick packet');
            return;
        }
        // tick simulation - should be identical to client (but will override client anyway)
        // update modifiers
        // tracks how many ticks of effect are remaining and corroborates with client array
        // modifiers are activated on the tick the client has them
        // importantly modifier timers only count down AFTER the tick they are activated in
        for (const [id, effect] of this.modifiers) {
            if (!effect.activated) continue;
            effect.length--;
            if (effect.length <= 0) {
                this.modifiers.delete(id);
                this.updateModifiers();
            }
        }
        for (const id of packet.modifiers) {
            const mod = this.modifiers.get(id);
            if (mod === undefined) {
                this.kick('bad_modifiers');
                return;
            } else {
                mod.activated = true;
                this.updateModifiers();
            }
        }
        // movement
        // grip is multiplier for player movements, lower values make the player "float" like on ice
        // friction is multiplier for player friction, lower values make the player "stick" to surfaces
        const onWall = (this.contactEdges.left || this.contactEdges.right) != 0;
        const onGround = (this.contactEdges.bottom || onWall) != 0;
        // apply friction from contact surfaces
        // friction is friction of player * friction of ground
        this.vx *= this.properties.friction * (this.contactEdges.top || 1) * (this.contactEdges.bottom || 1);
        this.vy *= this.properties.friction * (this.contactEdges.left || 1) * (this.contactEdges.right || 1);
        // apply air drag
        this.vx *= this.properties.drag;
        this.vy *= this.properties.drag;
        // apply velocity from inputs
        // on ground (bottom contact): full movement speed, jumps (power * grip * wall friction)
        // on walls (side contacts): full movement speed, but wall jumps too (power * grip * wall friction); wall slide drag is e^(wall friction * grip)
        // on ceiling: oof
        // in air (no contacts): air multiplier, no jumps
        // some shenanigans with js boolean operators used here, so it looks weird
        const groundGrip = this.properties.grip * (!onGround ? this.properties.airMovePower : (onWall ? -1 : 1));
        const wallGrip = this.properties.grip * (this.contactEdges.left || 1) * (this.contactEdges.right || 1);
        if ((this.contactEdges.left && packet.inputs.left) || (this.contactEdges.right && packet.inputs.right)) this.vy *= Math.pow(2, -wallGrip);
        this.vx += ((packet.inputs.left ? -1 : 0) + (packet.inputs.right ? 1 : 0)) * this.properties.movePower * groundGrip;
        this.vy += this.properties.jumpPower * wallGrip;
        // apply gravity using correct angle
        this.vy -= this.properties.gravity * this.cosVal;
        this.vx += this.properties.gravity * this.sinVal;
        // move to next position
        this.nextPosition();
    }

    get tickData(): PlayerTickData {
        return {
            ...super.tickData,
            username: this.username,
            color: this.color,
            contactEdges: this.contactEdges,
            properties: this.properties,
            modifiers: Array.from(this.modifiers.entries(), ([id, mod]) => ({ id: id, modifier: mod.modifier, length: mod.length }))
        };
    }

    setPosition(x: number, y: number, angle?: number): void {
        // need to teleport without desyncing server/client
        // override client position on next tick, completely bypassing anticheat
    }

    setVelocity(vx: number, vy: number, va?: number): void {
        // override client position on next tick, completely bypassing anticheat
    }

    private updateModifiers(): void {
        this.properties.gravity = Player.baseProperties.gravity;
        this.properties.movePower = Player.baseProperties.movePower;
        this.properties.jumpPower = Player.baseProperties.jumpPower;
        this.properties.airMovePower = Player.baseProperties.airMovePower;
        this.properties.drag = Player.baseProperties.drag;
        this.properties.friction = Player.baseProperties.friction;
        this.properties.grip = Player.baseProperties.grip;
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
interface PlayerTickInput {
    /**Client tick number, not strictly linked to server tickrate */
    readonly tick: number
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

/**
 * All data necessary to create one player on the client, fetched each tick.
 */
export interface PlayerTickData extends EntityTickData {
    readonly username: string
    readonly color: string
    readonly contactEdges: Entity['contactEdges']
    readonly properties: Player['properties']
    readonly modifiers: { id: number, modifier: Modifiers, length: number }[]
}

/**
 * Enumeration of player effects, usually achieved through lootboxes
 */
export enum Modifiers {
    /**Makes you faaaast */
    MOVE_POWER,
    /**Makes you faaaast faster */
    MOVE_DRAG,
    /**Makes you jump higher */
    JUMP_POWER,
    /**Allows you to completely stop on walls by pressing down */
    WALL_GRIP,
    /**Allows for full acceleration when not on ground */
    AIR_MOVE,
    /**Halves player friction for SPEEEED */
    LOW_FRICTION
}