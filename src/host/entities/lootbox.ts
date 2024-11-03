import { NamedLogger } from '@/common/log';

import { logger } from '../host';
import GameMap from '../map';
import Entity, { EntityTickData } from './entity';
import { LootBoxType } from './lootbox2';
import LootBoxRespawn from './lootboxrespawn';

/**
 * A lootbox that grants effects or items to players upon contact with them. Lootboxes spawn
 * from map spawners and will respawn after a set period of time if spawned from the map.
 */
export class LootBox extends Entity {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'LootBox');
    
    static readonly list: Map<number, LootBox> = new Map();
    static readonly chunks: Map<number, Map<number, Set<LootBox>>> = new Map();

    readonly type: LootBoxType;
    readonly respawns: boolean;

    constructor(x: number, y: number, type: LootBoxType, respawns: boolean) {
        super(x, y, 1, 1, 0);
        this.type = type;
        this.respawns = respawns;
        // move down to ground
        this.vy = -1;
        this.nextPosition();
        this.updateChunkPosition(LootBox.chunks);
        console.log(LootBox.chunkSize)
    }

    tick() {
        // no movement
    }
    
    get tickData(): LootBoxTickData {
        return {
            ...super.tickData
        };
    }

    remove() {
        // start respawn timer
        if (this.respawns) new LootBoxRespawn(this.x, this.y, this.type, 800);
    }

    /**
     * Advances all lootboxes to the next tick.
     * @returns Lootbox tick data for clients
     */
    static nextTick(): LootBoxTickData[] {
        return Entity.tickList(LootBox.list.values());
    }

    /**
     * Removes existing lootboxes, then attempts to spread lootboxes across the current map
     * by the map spawners ({@link GameMap.lootboxSpawnpoints}).
     */
    static spawnLootBoxes(): void {
        this.removeAll();
        const spawnpoints = GameMap.current?.lootboxSpawnpoints;
        if (spawnpoints === undefined) return;
        for (const spawnpoint of spawnpoints) new LootBox(spawnpoint.pos.x, spawnpoint.pos.y, spawnpoint.type, true);
    }

    /**
     * Removes all lootboxes and lootbox respawn timers.
     */
    static removeAll(): void {
        LootBox.list.clear();
        LootBoxRespawn.list.clear();
    }
}

/**
 * All data necessary to create one lootbox on the client, fetched each tick.
 */
export interface LootBoxTickData extends EntityTickData {
}

export default LootBox;