import { NamedLogger } from '@/common/log';
import config from '@/config';

import { logger } from '../host';
import GameMap, { MapCollision } from '../map';

/**
 * The generic `Entity` class that the physics engine will run on. Has basic movement and collisions.
 */
export abstract class Entity implements Collidable {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'Entity');

    static readonly chunks: Map<number, Map<number, Set<Entity>>> = new Map();

    /**Global tick counter that increments for every tick */
    static tick: number = 0;
    /**
     * Number of subunits to divide each grid unit into for movement physics - larger values are more accurate but slower.
     * **Small values cause inconsistent collisions!**
     */
    static readonly physicsResolution: number = config.gamePhysicsResolution;
    static readonly physicsBuffer: number = 0.01;
    static readonly chunkSize: number = 8;

    private static idCounter: number = 0;
    readonly id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
    vx: number;
    vy: number;
    va: number;
    gridx: number;
    gridy: number;
    chunk: { x1: number, x2: number, y1: number, y2: number };
    cosVal: number = NaN;
    sinVal: number = NaN;
    readonly boundingBox: Collidable['boundingBox'] = {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0
    };
    readonly vertices: Point[] = [];
    /**Friction coefficients of contact sides (along the axes), where zero is no friction or no contact */
    readonly contactEdges: {
        left: number
        right: number
        top: number
        bottom: number
    } = {
            left: 0,
            right: 0,
            top: 0,
            bottom: 0
        };
    hasCollision: boolean = true;
    allowOutOfBounds: boolean = true;

    /**
     * @param x Initial X position
     * @param y Initial Y position
     * @param w Width
     * @param h Height
     * @param angle Initial rotation
     * @param vx Initial velocity in X axis
     * @param vy Initial velocity in Y axis
     */
    constructor(x: number, y: number, w: number, h: number, angle?: number, vx?: number, vy?: number, va?: number) {
        this.id = Entity.idCounter++;
        this.x = x;
        this.y = y;
        this.width = w;
        this.height = h;
        this.angle = angle ?? 0;
        this.va = va ?? 0;
        this.vx = vx ?? 0;
        this.vy = vy ?? 0;
        this.gridx = Math.floor(x);
        this.gridy = Math.floor(y);
        this.chunk = { x1: NaN, x2: NaN, y1: NaN, y2: NaN };
        this.calculateCollisionInfo();
    }

    /**
     * Function run on every server tick.
     */
    tick(): void {
        this.nextPosition();
    }

    /**
     * Moves the entity to its "next" position following its velocity (`vx` and `vy`) and map collisions.
     * Note that translations are calculated first, then rotations.
     */
    nextPosition(): void {
        this.contactEdges.left = this.contactEdges.right = this.contactEdges.top = this.contactEdges.bottom = 0;
        if (!this.hasCollision) {
            this.x += this.vx;
            this.y += this.vy;
            this.angle += this.va;
            return;
        }
        const steps = Math.max(Math.abs(this.vx), Math.abs(this.vy)) * Entity.physicsResolution;
        const step = 1 / steps;
        const pos = {
            x: this.x,
            y: this.y,
            lx: this.x,
            ly: this.y,
            dx: this.vx / steps,
            dy: this.vy / steps
        };
        const mapBounds = {
            x1: -this.boundingBox.left,
            x2: (GameMap.current?.width ?? 1) - this.boundingBox.right,
            y1: -this.boundingBox.bottom - 10,
            y2: (GameMap.current?.height ?? 1) - this.boundingBox.top + 10,
        };
        for (let i = step; i <= 1 && (pos.dx != 0 || pos.dy != 0); i += step) {
            pos.lx = pos.x;
            pos.ly = pos.y;
            if (this.allowOutOfBounds) {
                pos.x += pos.dx;
                pos.y += pos.dy;
            } else {
                pos.x = Math.max(mapBounds.x1, Math.min(pos.x + pos.dx, mapBounds.x2));
                pos.y = Math.max(mapBounds.y1, Math.min(pos.y + pos.dy, mapBounds.y2));
            }
            const col1 = this.collidesWithMap(pos.x, pos.y);
            if (col1 !== null) {
                const col2 = this.collidesWithMap(pos.x, pos.ly);
                if (col2 !== null) {
                    const col3 = this.collidesWithMap(pos.lx, pos.y);
                    if (col3 !== null) {
                        // stuck!
                        pos.x = pos.lx;
                        pos.y = pos.ly;
                        pos.dx = this.vx = 0;
                        pos.dy = this.vy = 0;
                        this.contactEdges.left = this.contactEdges.right = this.contactEdges.top = this.contactEdges.bottom = col3.friction;
                        break;
                    } else {
                        // vertical slide, snap to vertical face
                        const dir = pos.x < col2.x;
                        // these are wrong
                        pos.x = pos.lx = dir ? (col2.boundingBox.left - this.boundingBox.right - Entity.physicsBuffer) : (col2.boundingBox.right - this.boundingBox.left + Entity.physicsBuffer);
                        pos.dx = this.vx = 0;
                        if (dir) this.contactEdges.right = col2.friction;
                        else this.contactEdges.left = col2.friction;
                    }
                } else {
                    // horizontal slide, snap to horizontal face
                    const dir = pos.y < col1.y;
                    pos.y = pos.ly = dir ? (col1.boundingBox.bottom - this.boundingBox.top - Entity.physicsBuffer) : (col1.boundingBox.top - this.boundingBox.bottom + Entity.physicsBuffer);
                    pos.dy = this.vy = 0;
                    if (dir) this.contactEdges.top = col1.friction;
                    else this.contactEdges.bottom = col1.friction;
                }
            }
        }
        this.x = pos.x;
        this.y = pos.y;
        this.angle += this.va;
        this.calculateCollisionInfo();
        this.calculateCollisionInfo();
        // const offset = 2 * Entity.physicsBuffer;
        // this.contactEdges.top = this.contactEdges.top || (this.collidesWithMap(this.x, this.y + offset)?.friction ?? this.contactEdges.top);
        // this.contactEdges.bottom = this.contactEdges.bottom || (this.collidesWithMap(this.x, this.y - offset)?.friction ?? this.contactEdges.bottom);
        // this.contactEdges.left = this.contactEdges.left || (this.collidesWithMap(this.x - offset, this.y)?.friction ?? this.contactEdges.left);
        // this.contactEdges.right = this.contactEdges.right || (this.collidesWithMap(this.x + offset, this.y)?.friction ?? this.contactEdges.right);
    }

    /**
     * If the entity would intersect with any part of the map when placed at the coordinates (`x`, `y`).
     * If so, returns the colliding segment.
     * @param x X coordinate to test
     * @param y Y coordinate to test
     * @returns First colliding object or null if no collisions detected.
     */
    collidesWithMap(x: number, y: number): MapCollision | null {
        if (GameMap.current === undefined) return null;
        const sx = Math.max(Math.floor(x + this.boundingBox.left), 0);
        const ex = Math.min(Math.ceil(x + this.boundingBox.right), GameMap.current.width - 1);
        const sy = Math.max(Math.floor(y + this.boundingBox.bottom), 0);
        const ey = Math.min(Math.ceil(y + this.boundingBox.top), GameMap.current.height - 1);
        const dx = x - this.x;
        const dy = y - this.y;
        const vertices = this.vertices.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        for (let cy = sy; cy <= ey; cy++) {
            for (let cx = sx; cx <= ex; cx++) {
                for (const col of GameMap.current.collisionGrid[cy][cx]) {
                    if (x + this.boundingBox.left > col.boundingBox.right
                        || x + this.boundingBox.right < col.boundingBox.left
                        || y + this.boundingBox.top < col.boundingBox.bottom
                        || y + this.boundingBox.bottom > col.boundingBox.top
                    ) {
                        continue;
                    }
                    for (const p of vertices) {
                        if (col.vertices.every((q, i) => Entity.isWithin(p, q, col.vertices[(i + 1) % col.vertices.length]))) {
                            return col;
                        }
                    }
                    for (const p of col.vertices) {
                        if (vertices.every((q, i) => Entity.isWithin(p, q, vertices[(i + 1) % vertices.length]))) {
                            return col;
                        }
                    }
                }
            }
        }
        return null;
    }

    /**
     * If the entity is currently intersecting with another entity or other {@link Collidable} object.
     * Uses a convex hull-like algorithm for intersections of convex polygons.
     * **Note: This algorithm doesn't work for all cases, but those cases can't be reached without passing through a detectable case.**
     * @param that Other entity to check collision with
     * @returns If the entities are colliding
     */
    collidesWithEntity(that: Collidable): boolean {
        if (this.x + this.boundingBox.left > that.x + this.boundingBox.right
            || this.x + this.boundingBox.right < that.x + this.boundingBox.left
            || this.y + this.boundingBox.top < that.y + this.boundingBox.bottom
            || this.y + this.boundingBox.bottom > that.y + this.boundingBox.top
        ) {
            return false;
        }
        for (const p of this.vertices) {
            if (that.vertices.every((q, i) => Entity.isWithin(p, q, that.vertices[(i + 1) % that.vertices.length]))) {
                return true;
            }
        }
        for (const p of that.vertices) {
            if (this.vertices.every((q, i) => Entity.isWithin(p, q, this.vertices[(i + 1) % this.vertices.length]))) {
                return true;
            }
        }
        return false;
    }

    /**
     * Determines if point P is "within" the boundary formed by points Q and R by
     * checking if the determinant of the below matrix is positive or zero.
     * ```
     * |  1   1   1  |
     * | Q.x P.x R.x |
     * | Q.y P.y R.y |
     * ```
     * @param p Test point P
     * @param q Boundary point Q
     * @param r Boundary point R
     * @returns If point P is within the boundary of QR
     */
    private static isWithin(p: Point, q: Point, r: Point): boolean {
        return q.x * (p.y - r.y) + p.x * (r.y - q.y) + r.x * (q.y - p.y) >= 0;
    }

    /**
     * Calculates essential values for collisions that would otherwise be redundantly calculated. MUST
     * be called after any angle, position, or size changes or some collisions will behave weirdly!
     */
    calculateCollisionInfo(): void {
        this.gridx = Math.floor(this.x);
        this.gridy = Math.floor(this.y);
        this.cosVal = Math.cos(this.angle);
        this.sinVal = Math.sin(this.angle);
        this.boundingBox.right = (Math.abs(this.width * this.cosVal) + Math.abs(this.height * this.sinVal)) / 2;
        this.boundingBox.left = -this.boundingBox.right;
        this.boundingBox.top = (Math.abs(this.height * this.cosVal) + Math.abs(this.width * this.sinVal)) / 2;
        this.boundingBox.bottom = -this.boundingBox.top;
        const hWidth = this.width / 2;
        const hHeight = this.height / 2;
        this.vertices[0] = { x: this.x - hWidth * this.cosVal - hHeight * this.sinVal, y: this.y + hHeight * this.cosVal - hWidth * this.sinVal };
        this.vertices[0] = { x: this.x + hWidth * this.cosVal - hHeight * this.sinVal, y: this.y + hHeight * this.cosVal + hWidth * this.sinVal };
        this.vertices[0] = { x: this.x + hWidth * this.cosVal + hHeight * this.sinVal, y: this.y - hHeight * this.cosVal + hWidth * this.sinVal };
        this.vertices[0] = { x: this.x - hWidth * this.cosVal + hHeight * this.sinVal, y: this.y - hHeight * this.cosVal - hWidth * this.sinVal };
        this.updateChunkPosition(Entity.chunks);
    }

    /**
     * Update the chunks the entity is within.
     * 
     * **Note**: `chunkGrid` has no safeguard against putting a chunk
     * grid of a subclass, which may cause issues not detectable by TypeScript.
     * @param chunkGrid Map that chunks are stored in
     */
    updateChunkPosition(chunkGrid: Map<number, Map<number, Set<Entity>>>): void {
        const chunks = chunkGrid;
        const lastChunk = structuredClone(this.chunk);
        this.chunk = {
            x1: Math.floor(this.boundingBox.left / Entity.chunkSize),
            x2: Math.floor(this.boundingBox.right / Entity.chunkSize),
            y1: Math.floor(this.boundingBox.bottom / Entity.chunkSize),
            y2: Math.floor(this.boundingBox.top / Entity.chunkSize)
        };
        if (this.chunk.x1 != lastChunk.x1 || this.chunk.x2 != lastChunk.x2 || this.chunk.x1 != lastChunk.x1 || this.chunk.x2 != lastChunk.x2) {
            for (let i = lastChunk.y1; i <= lastChunk.y2; i++) {
                const col = chunks.get(i);
                if (col === undefined) continue;
                for (let j = lastChunk.x1; j <= lastChunk.x2; j++) {
                    // if (i >= this.chunk.y1 && i <= this.chunk.y2 && j >= this.chunk.x1 && j <= this.chunk.x2) continue;
                    col.get(j)?.delete(this);
                }
            }
            for (let i = this.chunk.y1; i <= this.chunk.y2; i++) {
                const col = chunks.get(i);
                if (col === undefined) continue;
                for (let j = this.chunk.x1; j <= this.chunk.x2; j++) {
                    // if (i >= lastChunk.y1 && i <= lastChunk.y2 && j >= lastChunk.x1 && j <= lastChunk.x2) continue;
                    col.get(j)?.add(this);
                }
            }
        }
    }

    /**
     * Get a list of entities from a chunk grid that are within the same chunks.
     * @param chunkGrid Map that chunks are stored in
     * @returns Entity list
     */
    getInSameChunks<E extends Entity>(chunkGrid: Map<number, Map<number, Set<E>>>): E[] {
        const chunks = chunkGrid;
        const entities: E[] = [];
        for (let i = this.chunk.y1; i <= this.chunk.y2; i++) {
            const col = chunks.get(i);
            if (col === undefined) continue;
            for (let j = this.chunk.x1; j <= this.chunk.x2; j++) {
                const l = col.get(j);
                if (l != undefined) entities.push(...l);
            }
        }
        return entities;
    }

    /**
     * Set the position of the player.
     * @param x New X coordinate
     * @param y New Y coordinate
     * @param angle New angle
     */
    setPosition(x: number, y: number, angle?: number): void {
        this.x = x;
        this.y = y;
        this.angle = angle ?? this.angle;
        this.calculateCollisionInfo();
    }

    /**
     * Set the velocity of the player.
     * @param vx X-component of new velocity
     * @param vy Y-component of new velocity
     * @param va Angular velocity - **NOT FUNCTIONAL**
     */
    setVelocity(vx: number, vy: number, va?: number): void {
        this.vx = vx;
        this.vy = vy;
        this.va = va ?? this.va;
    }

    /**
     * Get the Euclidean distance to another point (often another entity).
     * @param that Other point or entity
     * @returns Euclidean distance to the point
     */
    distanceTo(that: Point): number {
        return Math.sqrt((this.x - that.x) ** 2 + (this.y - that.y) ** 2);
    }

    /**
     * Get the maximum distance along an axis to another point (often another entity).
     * The point (6, 4) is 5 units away from (1, 5) since it is 5 away on the x-axis and 1 away on the y-axis.
     * @param that Other point or entity
     * @returns Maximum distance along an axis to the point
     */
    axisDistanceTo(that: Point): number {
        return Math.max(Math.abs(this.x - that.x), Math.abs(this.y - that.y));
    }

    /**
     * Get the Euclidean distance to the grid location of another point (often another entity).
     * The grid location is determined by `gridx` and `gridy`.
     * @param that Other point or entity
     * @returns Euclidean distance to the point
     */
    gridDistanceTo(that: Entity | Point): number {
        return Math.sqrt((this.gridx - ((that as Entity).gridx ?? that.x)) ** 2 + (this.gridy - ((that as Entity).gridy ?? that.y)) ** 2);
    }

    /**
     * Get the maximum distance along an axis to the grid location of another point (often another entity).
     * The point (6, 4) is 5 units away from (1, 5) since it is 5 away on the x-axis and 1 away on the y-axis.
     * The grid location is determined by `gridx` and `gridy`.
     * @param that Other point or entity
     * @returns Euclidean distance to the point
     */
    gridAxisDistanceTo(that: Entity | Point): number {
        return Math.max(Math.abs(this.gridx - ((that as Entity).gridx ?? that.x)), Math.abs(this.gridy - ((that as Entity).gridy ?? that.y)));
    }

    get tickData(): EntityTickData {
        return {
            id: this.id,
            x: this.x,
            y: this.y,
            angle: this.angle,
            vx: this.vx,
            vy: this.vy,
            va: this.va
        };
    }

    /**
     * Removes the entity from the world.
     */
    remove(): void { }

    /**
     * Advances entities to the next tick. Doesn't actually tick any entities, but imcrements the global tick.
     * @returns Empty array
     */
    static nextTick(): EntityTickData[] {
        Entity.tick++;
        return [];
    }

    static tickList<E extends Entity>(list: Iterable<E>): E['tickData'][] {
        return Array.from(list, (entity) => {
            entity.tick();
            return entity.tickData;
        });
    }
}

/**
 * All data necessary to create one entity on the client, fetched each tick.
 */
export interface EntityTickData {
    readonly id: number
    readonly x: number
    readonly y: number
    readonly angle: number
    readonly vx: number
    readonly vy: number
    readonly va: number
}

/**
 * A point in 2D space.
 */
export interface Point {
    x: number
    y: number
}

/**
 * A convex polygon with a location and bounding box that can be checked for intersection with any `Entity`.
 */
export interface Collidable {
    /**X coordinate */
    readonly x: number
    /**Y coordinate */
    readonly y: number
    /**Relative coordinates of axis-aligned rectangular bounding box - left/right are X, top/bottom are Y */
    readonly boundingBox: {
        left: number
        right: number
        top: number
        bottom: number
    }
    /**List of vertices going clockwise that make up a convex polygon to define the collision shape of the entity */
    readonly vertices: Point[]
}

export default Entity;