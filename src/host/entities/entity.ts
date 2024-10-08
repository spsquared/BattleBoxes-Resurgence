/**
 * The generic `Entity` class that the physics engine will run on. Has basic movement and collisions.
 */
export abstract class Entity {
    /**Global tick counter that increments for every tick */
    static tick: number = 0;

    private static idCounter: number;
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
    cosVal: number = NaN;
    sinVal: number = NaN;
    boundingWidth: number = NaN;
    boundingHeight: number = NaN;
    halfBoundingWidth: number = NaN;
    halfBoundingHeight: number = NaN;
    readonly vertices: Point[] = [];
    readonly contactEdges: {
        left: boolean
        right: boolean
        top: boolean
        bottom: boolean
    } = {
            left: false,
            right: false,
            top: false,
            bottom: false
        };
    hasCollision: boolean = true;

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
        this.gridx = Math.floor(y);
        this.gridy = Math.floor(y);
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
        const startx = this.x;
        const starty = this.y;
        const steps = Math.ceil(Math.max(Math.abs(this.vx), Math.abs(this.vy)));
        const xStep = this.vx / steps;
        const yStep = this.vy / steps;
        const pos = {
            x: this.x,
            y: this.y,
            lx: this.x,
            ly: this.y
        };
        for (let step = 1; step <= steps; step++) {
            pos.lx = pos.x;
            pos.ly = pos.y;
            pos.x = this.x + xStep * step;
            pos.y = this.y + yStep * step;
            if (this.collidesWithMap(pos.x, pos.y)) {
                if (this.collidesWithMap(pos.x, pos.ly)) {
                    if (this.collidesWithMap(pos.lx, pos.y)) {
                        // stuck, can't go anywhere
                        pos.x = pos.lx;
                        pos.y = pos.ly;
                        break;
                    } else {
                        // vertical slide
                        pos.x = pos.lx;
                    }
                } else {
                    // horizontal slide
                    pos.y = pos.ly;
                }
            }
        }
        this.x = pos.x;
        this.y = pos.y;
        this.vx = this.x - startx;
        this.vy = this.y - starty;
        this.angle += this.va;
        this.calculateCollisionInfo();
        this.contactEdges.left = this.collidesWithMap(this.x - 1, this.y);
        this.contactEdges.right = this.collidesWithMap(this.x + 1, this.y);
        this.contactEdges.top = this.collidesWithMap(this.x, this.y - 1);
        this.contactEdges.bottom = this.collidesWithMap(this.x, this.y + 1);
    }

    /**
     * If the entity would intersect with any part of the map when placed at the coordinates (`x`, `y`).
     * @param x X coordinate to test
     * @param y Y coordinate to test
     * @returns If the entity would collide
     */
    collidesWithMap(x: number, y: number): boolean {
        return false;
    }

    /**
     * If the entity is currently intersecting with another entity.
     * Uses a convex hull-like algorithm for intersections of arbitrary convex polygons.
     * @param that Other entity to check collision with
     * @returns If the entities are colliding
     */
    collidesWithEntity(that: Entity): boolean {
        if (Math.abs(this.x - that.x) > this.halfBoundingWidth + that.halfBoundingWidth || Math.abs(this.y - that.y) > this.halfBoundingHeight + that.halfBoundingHeight) {
            return false;
        }
        // uses a convex hull-like algorithm to detect points within convex polygons
        for (const p of this.vertices) {
            if (that.vertices.every((q, i) => this.isWithin(p, q, that.vertices[(i + 1) % that.vertices.length]))) {
                return true;
            }
        }
        for (const p of that.vertices) {
            if (this.vertices.every((q, i) => this.isWithin(p, q, this.vertices[(i + 1) % this.vertices.length]))) {
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
    private isWithin(p: Point, q: Point, r: Point): boolean {
        return q.x * (p.y - r.y) + p.x * (r.y - q.y) + r.x * (q.y - p.y) >= 0;
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
    axisDistanceTo(that: Entity): number {
        return Math.max(Math.abs(this.x - that.x), Math.abs(this.y - that.y));
    }

    /**
     * Get the Euclidean distance to the grid location of another point (often another entity).
     * The grid location is determined by `gridx` and `gridy`.
     * @param that Other point or entity
     * @returns Euclidean distance to the point
     */
    gridDistanceTo(that: Entity): number {
        return Math.sqrt((this.gridx - that.gridx))
    }

    /**
     * Get the maximum distance along an axis to the grid location of another point (often another entity).
     * The point (6, 4) is 5 units away from (1, 5) since it is 5 away on the x-axis and 1 away on the y-axis.
     * The grid location is determined by `gridx` and `gridy`.
     * @param that Other point or entity
     * @returns Euclidean distance to the point
     */
    gridAxisDistanceTo(that: Entity): number {
        return Math.max(Math.abs(this.gridx - that.gridx), Math.abs(this.gridy - that.gridy));
    }

    /**
     * Calculates essential values for collisions that would otherwise be redundantly calculated. MUST
     * be called after any angle, position, or size changes or some collisions will behave weirdly!
     */
    calculateCollisionInfo() {
        this.gridx = Math.floor(this.x);
        this.gridy = Math.floor(this.y);
        this.cosVal = Math.cos(this.angle);
        this.sinVal = Math.sin(this.angle);
        this.boundingWidth = Math.abs(this.width * this.cosVal) + Math.abs(this.height * this.sinVal);
        this.boundingHeight = Math.abs(this.height * this.cosVal) + Math.abs(this.width * this.sinVal);
        this.halfBoundingWidth = this.boundingWidth / 2;
        this.halfBoundingHeight = this.boundingHeight / 2;
        let hWidth = this.width / 2;
        let hHeight = this.height / 2;
        this.vertices[0] = { x: this.x - this.cosVal * hWidth + this.sinVal * hHeight, y: this.y + this.cosVal * hWidth + this.sinVal * hHeight };
        this.vertices[1] = { x: this.x + this.cosVal * hWidth + this.sinVal * hHeight, y: this.y - this.cosVal * hWidth + this.sinVal * hHeight };
        this.vertices[2] = { x: this.x + this.cosVal * hWidth - this.sinVal * hHeight, y: this.y - this.cosVal * hWidth - this.sinVal * hHeight };
        this.vertices[3] = { x: this.x - this.cosVal * hWidth - this.sinVal * hHeight, y: this.y + this.cosVal * hWidth - this.sinVal * hHeight };
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

    remove(): void { }

    /**
     * Advances entities to the next tick. Doesn't actually tick any entities, but imcrements the global tick.
     * @returns Empty array
     */
    static nextTick(): EntityTickData[] {
        Entity.tick++;
        return [];
    }
}

export interface EntityTickData {
    readonly id: number
    readonly x: number
    readonly y: number
    readonly angle: number
    readonly vx: number
    readonly vy: number
    readonly va: number
}

export interface Point {
    x: number,
    y: number
}