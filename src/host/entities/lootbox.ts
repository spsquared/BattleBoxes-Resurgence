import { NamedLogger } from '@/common/log';
import { logger } from '../host';
import Entity from './entity';
import { LootBoxType } from './lootbox2';

export class LootBox extends Entity {
    static readonly logger: NamedLogger = new NamedLogger(logger, 'LootBox');
    
    static readonly list: Map<number, LootBox> = new Map();

    constructor(x: number, y: number, type: LootBoxType) {
        super(x, y, 1, 1, 0);
    }

    // delete movement function and don't bother with collisions

}

export default LootBox;