import { NamedLogger } from '@/common/log';

import { logger } from '../host';
import Entity, { EntityTickData } from './entity';
import LootBox from './lootbox';
import { LootBoxType } from './lootbox2';

/**
 * {@link LootBox} respawn timer entity. This entity will never appear on clients.
 */
export class LootBoxRespawn extends Entity {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'LootBoxRespawn');
    
    static readonly list: Map<number, LootBoxRespawn> = new Map();
    static readonly chunks: Map<number, Map<number, Set<LootBoxRespawn>>> = new Map();

    readonly type: LootBoxType;
    timer: number;

    constructor(x: number, y: number, type: LootBoxType, delay: number) {
        super(x, y, 1, 1, 0);
        this.type = type;
        this.timer = delay;
        this.updateChunkPosition(LootBoxRespawn.chunks);
    }

    tick() {
        // count down timer, once zero remove self and spawn new lootbox
        this.timer--;
        if (this.timer <= 0) {
            new LootBox(this.x, this.y, this.type, true);
            this.remove();
        }
    }

    /**
     * Advances all lootbox respawn timers to the next tick.
     * @returns Tick data, however this isn't used on clients anyway
     */
    static nextTick(): LootBoxRespawnTickData[] {
        return Entity.tickList(LootBoxRespawn.list.values());
    }
}

/**
 * useless
 */
export interface LootBoxRespawnTickData extends EntityTickData {
}

export default LootBoxRespawn;