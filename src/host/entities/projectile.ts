import { NamedLogger } from '@/common/log';

import { logger } from '../host';
import GameMap from '../map';
import Entity, { EntityTickData, Point } from './entity';
import Player from './player';

/**
 * A projectile entity that can perform functions on collision with the ground or another entity.
 * Can have various movement patterns and collision shapes, as defined in the static `types` list.
 */
export class Projectile extends Entity {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'Projectile');

    static readonly list: Map<number, Projectile> = new Map();
    static readonly chunks: Set<Projectile>[][] = Entity.createChunks<Projectile>();

    /**
     * Default movement patterns for projectiles, called each tick on the projectile to move it.
     */
    static readonly moveFunctions = {
        linear: function (this: Projectile) {
        }
    }
    /**
     * All projectile templates available. The key (e.g. "bullet") is the `type` parameter of the Projectile constructor.
     */
    static readonly types = {
        bullet: {
            speed: 0.8,
            angularSpeed: 0,
            vertices: [
                { x: -0.375, y: 0.125 },
                { x: 0.125, y: 0.125 },
                { x: 0.125, y: -0.125 },
                { x: -0.375, y: -0.125 },
                { x: -0.875, y: 0 }
            ],
            moveFunction: Projectile.moveFunctions.linear,
            onMapHit: function (this: Projectile) {
                this.remove();
            },
            onEntityHit: function (this: Projectile, entity: Entity) {
                if (entity instanceof Player) entity.damage(1);
                this.remove();
            },
            collidesWith: {
                player: true,
                projectile: false
            }
        } satisfies ProjectileType
    };
    static readonly typeVertices: { [key in keyof typeof Projectile.types]: Point[] } = Object.entries(Projectile.types).reduce((map, [id, data]: [any, ProjectileType]) => {
        map[id] = data.vertices;
        return map;
    }, {} as any);
    static readonly outOfBoundsLimit = 20;

    readonly type: keyof typeof Projectile.types;
    readonly typeData: ProjectileType;
    readonly parent: Player;

    constructor(type: keyof typeof Projectile.types, parent: Player, x: number, y: number, angle: number) {
        super(x, y, 0, 0, angle);
        this.type = type;
        this.typeData = Projectile.types[type];
        this.parent = parent;
        this.setVelocity(this.parent.vx * 0.25 + this.typeData.speed * this.cosVal, this.parent.vy * 0.25 + this.typeData.speed * this.sinVal, this.typeData.angularSpeed);
        Projectile.list.set(this.id, this);
    }

    tick() {
        if (this.x < -Projectile.outOfBoundsLimit || this.x > (GameMap.current?.width ?? 0) + Projectile.outOfBoundsLimit || this.y < -Projectile.outOfBoundsLimit || this.y > (GameMap.current?.height ?? 0) + Projectile.outOfBoundsLimit) {
            this.remove();
            return;
        }
        this.typeData.moveFunction.call(this);
        this.nextPosition();
        if (this.contactEdges.left || this.contactEdges.right || this.contactEdges.bottom || this.contactEdges.top) {
            this.typeData.onMapHit.call(this);
        }
        if (this.typeData.collidesWith.player) {
            const players = this.getInSameChunks(Player.chunks);
            for (const player of players) if (player !== this.parent && this.collidesWithEntity(player)) this.typeData.onEntityHit.call(this, player);
        }
        if (this.typeData.collidesWith.projectile) {
            const projectiles = this.getInSameChunks(Projectile.chunks);
            for (const projectile of projectiles) if (projectile !== this && this.collidesWithEntity(projectile)) this.typeData.onEntityHit.call(this, projectile);
        }
    }

    calculateCollisionInfo(): void {
        this.gridx = Math.floor(this.x);
        this.gridy = Math.floor(this.y);
        this.cosVal = Math.cos(this.angle);
        this.sinVal = Math.sin(this.angle);
        // calculateCollisionInfo is called in Entity constructor, so removing undefined check results in crash
        this.vertices.length = 0;
        if (this.typeData !== undefined) this.vertices.push(...this.typeData.vertices.map((p) => ({
            x: this.x + p.x * this.cosVal - p.y * this.sinVal,
            y: this.y + p.y * this.cosVal + p.x * this.sinVal
        })));
        const xcoords = this.vertices.map((p) => p.x - this.x);
        const ycoords = this.vertices.map((p) => p.y - this.y);
        this.boundingBox.left = Math.min(...xcoords);
        this.boundingBox.right = Math.max(...xcoords);
        this.boundingBox.top = Math.max(...ycoords);
        this.boundingBox.bottom = Math.min(...ycoords);
        this.lastChunk = structuredClone(this.chunk);
        this.updateChunkPosition(Entity.chunks);
        this.updateChunkPosition(Projectile.chunks);
    }

    get tickData(): ProjectileTickData {
        return {
            ...super.tickData,
            type: this.type,
            parent: this.parent.username,
            boundingBox: this.boundingBox
        };
    }

    remove(): void {
        super.remove();
        // sets velocity to 0 so client doesn't look weird
        this.vx = 0;
        this.vy = 0;
        Projectile.list.delete(this.id);
    }

    /**
     * Removes all projectiles.
     */
    static removeAll(): void {
        for (const projectile of Projectile.list.values()) projectile.remove();
    }

    /**
     * Advances all projectiles to the next tick.
     * @returns Projectile tick data for clients
     */
    static nextTick(): ProjectileTickData[] {
        return Entity.tickList(Projectile.list.values());
    }
}

GameMap.onMapChange(() => { Projectile.chunks.length = 0; Projectile.chunks.push(...Entity.createChunks<Projectile>()) });

/**
 * Defines a projectile template.
 */
export interface ProjectileType {
    speed: number
    angularSpeed: number
    readonly vertices: Point[]
    moveFunction: () => void
    readonly onMapHit: () => void
    readonly onEntityHit: (entity: Entity) => void
    collidesWith: {
        player: boolean
        projectile: boolean
    }
}

/**
 * All data necessary to create one projectile on the client, fetched each tick.
 */
export interface ProjectileTickData extends EntityTickData {
    readonly type: keyof typeof Projectile.types
    readonly parent: string
    readonly boundingBox: Projectile['boundingBox']
}

export default Projectile;