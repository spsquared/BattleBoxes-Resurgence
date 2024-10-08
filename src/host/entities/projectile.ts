import { Entity } from "./entity";

export class Projectile extends Entity {
    static readonly list: Map<number, Projectile> = new Map();

    constructor(x: number, y: number, width: number, height: number, angle: number) {
        super(x, y, width, height, angle);
    }

    // override movement code to call a function on collision with map and a function on collision with player
    // default to remove on collision with map or player and damage players by 1
}