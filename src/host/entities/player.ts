import type { AccountData } from '@/common/database';
import { NamedLogger } from '@/common/log';

import { Game } from '../game';
import { logger } from '../host';
import GameMap from '../map';
import Entity, { EntityTickData, Point } from './entity';

/**
 * Represents a player controlled by a client. Movement physics is performed by the client and server in
 * lockstep to improve input response times, with server ticking initiated by client physics packets to
 * validate the movement and prevent cheating. Any discrepancy will cause the server to override the client.
 */
export class Player extends Entity {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'Player');

    static readonly list: Map<string, Player> = new Map();

    private static readonly maxFastTickInfractions = 10;
    private static readonly maxSlowTickInfractions = 20;
    private static readonly maxTickLead = 40;
    private static readonly maxTickLag = 80;
    private static readonly infractionDecayRate = 20;

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
        /**Forces override player position on the next tick */
        overrideNextTick: number
    } = {
            tick: 0,
            fastTickInfractions: 0,
            slowTickInfractions: 0,
            overrideNextTick: 0
        };

    static readonly baseProperties: Readonly<Player['properties']> = {
        gravity: 0.07,
        movePower: 0.3,
        jumpPower: 1,
        wallJumpPower: 0.8,
        airMovePower: 0.04,
        drag: 0.5,
        airDrag: 0.9,
        wallDrag: 0.5,
        grip: 0.8,
        fly: false
    };
    readonly properties: {
        gravity: number
        movePower: number
        jumpPower: number
        wallJumpPower: number
        airMovePower: number
        drag: number
        airDrag: number
        wallDrag: number
        grip: number
        fly: boolean
    } = {
            gravity: Player.baseProperties.gravity,
            movePower: Player.baseProperties.movePower,
            jumpPower: Player.baseProperties.jumpPower,
            wallJumpPower: Player.baseProperties.wallJumpPower,
            airMovePower: Player.baseProperties.airMovePower,
            drag: Player.baseProperties.drag,
            airDrag: Player.baseProperties.airDrag,
            wallDrag: Player.baseProperties.wallDrag,
            grip: Player.baseProperties.grip,
            fly: Player.baseProperties.fly
        };
    readonly modifiers: Map<number, { modifier: Modifiers, length: number, activated: boolean }> = new Map();

    private static readonly colorList = ['#F00', '#F90', '#0F0', '#0FC', '#09F', '#00F', '#90F', '#F0F'];
    private static readonly usedColors: Set<string> = new Set();
    readonly color: string;
    connected: boolean = false;

    constructor(data: AccountData) {
        super(0, 0, 0.75, 0.75);
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
        if (!this.connected) return;
        if (this.clientPhysics.tick - Entity.tick > Player.maxTickLead) {
            this.clientPhysics.fastTickInfractions++;
            this.logger.warn(`Client ahead of server ticking by ${this.clientPhysics.tick - Entity.tick} ticks - ${Player.maxFastTickInfractions - this.clientPhysics.fastTickInfractions} violations remain`);
            if (this.clientPhysics.fastTickInfractions >= Player.maxFastTickInfractions) {
                this.kick('client_too_fast');
                return;
            }
        } else if (Entity.tick - this.clientPhysics.tick > Player.maxTickLag) {
            this.clientPhysics.slowTickInfractions++;
            this.logger.warn(`Client behind server ticking by ${Entity.tick - this.clientPhysics.tick} ticks - ${Player.maxSlowTickInfractions - this.clientPhysics.slowTickInfractions} violations remain`);
            if (this.clientPhysics.slowTickInfractions >= Player.maxSlowTickInfractions) {
                this.kick('client_too_slow');
                return;
            }
        }
        if (Entity.tick % Player.infractionDecayRate == 0) {
            this.clientPhysics.fastTickInfractions = Math.max(0, this.clientPhysics.fastTickInfractions - 1);
            this.clientPhysics.slowTickInfractions = Math.max(0, this.clientPhysics.slowTickInfractions - 1);
        }
        if (this.clientPhysics.overrideNextTick > 0) this.clientPhysics.overrideNextTick--;
    }

    /**
     * Player-unique tick that runs when the client sends its physics tick to the server.
     * Validates the physics tick by running it on the same conditions
     * @param packet Client tick packet
     */
    physicsTick(p: PlayerTickInput): void {
        const packet = p;
        // update tick
        this.clientPhysics.tick = packet.tick;
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
        // flying moment
        if (this.properties.fly) {
            // flying just moves
            this.vx = ((packet.inputs.right ? 1 : 0) - (packet.inputs.left ? 1 : 0)) * this.properties.movePower;
            this.vy = ((packet.inputs.up ? 1 : 0) - (packet.inputs.down ? 1 : 0)) * this.properties.movePower;
            // next position
            this.nextPosition();
            return;
        }
        // movement
        //   drag is exponential decay base, always active when contacting map, friction becomes exponent
        //   grip is multiplier for intentional player movements, friction becomes coefficient
        // apply friction drag from contact surfaces (drag)
        //   drag is raised to exponent of friction * grip
        this.vx *= Math.pow(this.properties.drag, this.contactEdges.top + this.contactEdges.bottom);
        this.vy *= Math.pow(this.properties.drag, this.contactEdges.left + this.contactEdges.right);
        // apply air drag (airDrag)
        this.vx *= this.properties.airDrag;
        this.vy *= this.properties.airDrag;
        // apply velocity from inputs
        //   in air: air power movement, no jumps
        //   on ground (bottom): full movement (power * grip * friction), normal jumps (power)
        //   on walls (moving into side contacts): override normal movement
        //     persistent drag from wallslides (wallDrag) - drag ^ (friction * grip)
        //     up or down input activates wall jump - up jumps with move while down just moves
        //     wall jump jump power (power * grip * friction)
        //     wall jump move power (power * grip * friction)
        const moveInput = ((packet.inputs.right ? 1 : 0) - (packet.inputs.left ? 1 : 0));
        if (this.contactEdges.left * moveInput < 0 || this.contactEdges.right * moveInput > 0) {
            const friction = this.contactEdges.left + this.contactEdges.right;
            this.vy *= Math.pow(this.properties.wallDrag, friction);
            if (packet.inputs.up || (packet.inputs.down && this.contactEdges.bottom == 0)) {
                const jumpPower = this.properties.jumpPower * this.properties.grip * friction;
                this.vx -= moveInput * jumpPower * this.properties.wallJumpPower;
                if (packet.inputs.up) this.vy += jumpPower;
            }
        } else if (this.contactEdges.bottom != 0) {
            this.vx += moveInput * this.properties.movePower * this.properties.grip * this.contactEdges.bottom;
            if (packet.inputs.up) this.vy += this.properties.jumpPower;
        } else {
            this.vx += moveInput * this.properties.airMovePower;
        }
        // apply gravity with angle
        this.vy -= this.properties.gravity * this.cosVal;
        this.vx += this.properties.gravity * this.sinVal;
        // move to next position
        this.nextPosition();
        // corroborate positions
        if (this.x != packet.position.endx || this.y != packet.position.endy) {
            // counting infractions makes it easy for slight desync caused by teleports to kick players
            this.clientPhysics.overrideNextTick = 2;
        }
    }

    get tickData(): PlayerTickData {
        return {
            ...super.tickData,
            username: this.username,
            color: this.color,
            properties: this.properties,
            modifiers: Array.from(this.modifiers.entries(), ([id, mod]) => ({ id: id, modifier: mod.modifier, length: mod.length })),
            overridePosition: this.clientPhysics.overrideNextTick > 0
        };
    }

    /**
     * Teleports the player to a random spawnpoint on the map.
     */
    toRandomSpawnpoint(): void {
        if (GameMap.current === undefined) {
            this.logger.error('Could not teleport to random spawnpoint because no map is loaded');
            return;
        }
        const spawnpoint = Array.from(GameMap.current.playerSpawnpoints)[Math.floor(Math.random() * GameMap.current.playerSpawnpoints.size)];
        if (spawnpoint === undefined) {
            this.logger.error('Could not teleport to random spawnpoint because no spawnpoints');
            return;
        }
        this.setPosition(spawnpoint.x + 0.5, spawnpoint.y + 0.5);
    }

    private updateModifiers(): void {
        this.properties.gravity = Player.baseProperties.gravity;
        this.properties.movePower = Player.baseProperties.movePower;
        this.properties.jumpPower = Player.baseProperties.jumpPower;
        this.properties.airMovePower = Player.baseProperties.airMovePower;
        this.properties.drag = Player.baseProperties.drag;
        this.properties.airDrag = Player.baseProperties.airDrag;
        this.properties.wallDrag = Player.baseProperties.wallDrag;
        this.properties.grip = Player.baseProperties.grip;
    }

    setPosition(x: number, y: number, angle?: number): void {
        super.setPosition(x, y, angle);
        this.clientPhysics.overrideNextTick = 2;
    }

    setVelocity(vx: number, vy: number, va?: number): void {
        super.setVelocity(vx, vy, va);
        this.clientPhysics.overrideNextTick = 2;
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
        this.connected = false;
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

    /**
     * Spreads players throughout the map using the player spawnpoints.
     */
    static spreadPlayers(): void {
        if (GameMap.current === undefined) {
            Player.logger.error('Could not spread players because no map is loaded');
            return;
        }
        const unusedSpawns = Array.from(GameMap.current.playerSpawnpoints);
        for (const player of Player.list.values()) {
            const spawnpoint = unusedSpawns.splice(Math.floor(Math.random() * unusedSpawns.length), 1)[0];
            if (spawnpoint == undefined) {
                Player.logger.error('Could not spread players because not enough spawnpoints');
                break;
            }
            player.setPosition(spawnpoint.x + 0.5, spawnpoint.y + 0.5);
        }
    }
}

/**
 * A packet representing a client physics tick, to be cross-checked by the server to minimize cheating.
 * The server runs the same tick to make sure movement physics are unmodified and effect timers are correct.
 */
export interface PlayerTickInput {
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
    /**Position of player at end of tick (for verification of player position) */
    readonly position: {
        endx: number
        endy: number
    }
}

/**
 * All data necessary to create one player on the client, fetched each tick.
 */
export interface PlayerTickData extends EntityTickData {
    readonly username: string
    readonly color: string
    readonly properties: Player['properties']
    readonly modifiers: { id: number, modifier: Modifiers, length: number }[]
    readonly overridePosition: boolean
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

export default Player;