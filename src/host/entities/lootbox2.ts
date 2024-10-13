// this file exists solely to stop circular import shenanigans
// if lootbox.ts is imported in map.ts it will import entity.ts, however entity.ts isn't finished parsing
// as it imports map.ts, which makes the export undefined and crashes everything

export enum LootBoxType {
    RANDOM = '',
    POSITIVE = '+',
    NEGATIVE = '-'
}