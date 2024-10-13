import { readdir, readFile } from 'fs/promises';
import { resolve as pathResolve } from 'path';

import { NamedLogger } from '@/common/log';
import { reverse_enum } from '@/common/util';
import config from '@/config';

import { Collidable, Point } from './entities/entity';
import { LootBoxType } from './entities/lootbox2';
import { logger } from './host';

/**
 * Global map loader that creates and stores collision entities for maps from files found in the game resources.
 */
export class GameMap {
    static readonly maps: Map<string, GameMap> = new Map();
    static current?: GameMap = undefined;
    private static tileset: GameTileset | undefined;

    static readonly logger: NamedLogger = new NamedLogger(logger, 'GameMap');

    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly collisionGrid: MapCollision[][][];
    readonly playerSpawnpoints: Set<Point> = new Set();
    readonly lootboxSpawnpoints: Set<{ pos: Point, type: LootBoxType }> = new Set();

    /**
     * @param json Raw JSON string from file
     * @param name Unique name/ID of map
     */
    constructor(json: string, name: string) {
        this.name = name;
        if (config.debugMode) GameMap.logger.debug('Loading ' + this.name);
        const start = performance.now();
        const raw = JSON.parse(json);
        if (GameMap.tileset === undefined) throw new ReferenceError('Tileset was not loaded before map load');
        this.width = raw.width;
        this.height = raw.height;
        this.collisionGrid = Array.from(new Array(this.height), () => Array.from(new Array(this.width), () => new Array()));
        // loop through every tile in every layer and add collisions/spawnpoints
        for (const layer of raw.layers) {
            if (layer.width != this.width || layer.height != this.height || layer.data.length != this.width * this.height) throw new RangeError('Mismatched layer size with map size or data length');
            if (layer.name == 'Spawns') {
                // ensure minimum of gameMaxPlayers spawnpoints for spreading players
                let playerSpawns = 0;
                for (let i = 0; i < layer.data.length; i++) {
                    const tile = layer.data[i] - 1;
                    const x = i % this.width;
                    const y = this.height - ~~(i / this.width) - 1;
                    if (GameMap.tileset.playerSpawnpoints.has(tile)) {
                        this.playerSpawnpoints.add({ x: x, y: y });
                        playerSpawns++;
                    } else if (GameMap.tileset.lootboxSpawnpoints.has(tile)) {
                        this.lootboxSpawnpoints.add({
                            pos: { x: x, y: y },
                            type: GameMap.tileset.lootboxSpawnpoints.get(tile)!
                        });
                    }
                }
                if (playerSpawns < config.gameMaxPlayers) GameMap.logger.error(`Map "${this.name}" has insufficient spawnpoints (min: ${config.gameMaxPlayers}, found: ${playerSpawns})`);
            } else {
                // add collisions
                for (let i = 0; i < layer.data.length; i++) {
                    const tile = layer.data[i] - 1;
                    const x = i % this.width;
                    const y = this.height - ~~(i / this.width) - 1;
                    if (GameMap.tileset.collisionMaps[tile] == undefined) {
                        if (tile >= 0) GameMap.logger.error(`Tile with no collision map in "${this.name}" at (${x}, ${y}) - ${tile}`);
                    } else if (GameMap.tileset.collisionMaps[tile].length > 0) {
                        this.collisionGrid[y][x].push(...GameMap.tileset.collisionMaps[tile].map<MapCollision>((col) => ({
                            x: col.x + x,
                            y: col.y + y,
                            halfBoundingWidth: col.halfBoundingWidth,
                            halfBoundingHeight: col.halfBoundingHeight,
                            vertices: col.vertices.map((p) => ({ x: p.x + x, y: p.y + y })),
                            friction: col.friction
                        })));
                    }
                }
            }
        }
        GameMap.maps.set(this.name, this);
        if (config.debugMode) GameMap.logger.debug(`Loaded "${this.name}" in ${performance.now() - start}ms, size ${raw.width}x${raw.height}`, true);
    }

    /**
     * Clears map list and regenerates tileset and maps from file.
     */
    static async reloadMaps() {
        this.logger.info('Reloading maps');
        const start = performance.now();
        const [tilesetJson, mapsJson] = await Promise.all([
            readFile(pathResolve(config.gameSourcePath, 'tileset.json'), { encoding: 'utf8' }),
            readdir(pathResolve(config.gameSourcePath, 'maps/')).then((mapsList) => Promise.all(mapsList.map(async (map) => [map, await readFile(pathResolve(config.gameSourcePath, 'maps/', map), { encoding: 'utf8' })])))
        ]);
        this.logger.info('Maps found: ' + mapsJson.map(([name]) => name).join(', '))
        if (config.debugMode) this.logger.debug(`Read map data in ${performance.now() - start}ms`, true);
        this.maps.clear();
        this.tileset = new GameTileset(tilesetJson);
        for (const [name, json] of mapsJson) new GameMap(json, name.replace('.json', ''));
        this.logger.info(`Loaded maps in ${performance.now() - start}ms`);
    }
}

/**
 * Stores tileset data for maps, including collision templates.
 */
export class GameTileset {
    readonly collisionMaps: MapCollision[][];
    readonly playerSpawnpoints: Set<number> = new Set();
    readonly lootboxSpawnpoints: Map<number, LootBoxType> = new Map();

    /**
     * @param json Raw JSON string from file
     */
    constructor(json: string) {
        if (config.debugMode) GameMap.logger.debug('Loading tileset');
        const start = performance.now();
        const raw = JSON.parse(json);
        if (raw.tilewidth != raw.tileheight) throw new RangeError('Non-square tiles in tileset');
        this.collisionMaps = Array.from(new Array(raw.tilecount), () => new Array());
        let rectCount = 0;
        for (const tile of raw.tiles) {
            // check for spawnpoints
            const spawnpoint = (tile.properties?.find((prop: any) => prop.name == 'spawnpoint'))?.value;
            if (typeof spawnpoint == 'string') {
                const str = spawnpoint.split('=');
                findType: switch (str[0]) {
                    case SpawnpointType.PLAYER:
                        this.playerSpawnpoints.add(tile.id);
                        break;
                    case SpawnpointType.LOOTBOX:
                        for (const k in LootBoxType) if ((LootBoxType as any)[k] == str[1]) {
                            this.lootboxSpawnpoints.set(tile.id, (LootBoxType as any)[k]);
                            break findType;
                        }
                        throw new TypeError(`Invalid lootbox type "${str[1]}"`)
                    default:
                        throw new TypeError(`Invalid spawnpoint type "${str[0]}"`);
                }
            }
            // convert collision rectangles to collidables for entity collision
            if (tile.objectgroup == undefined) continue;
            const collisions = this.collisionMaps[tile.id];
            for (const col of tile.objectgroup.objects) {
                const hw = col.width / raw.tilewidth / 2;
                const hh = col.height / raw.tilewidth / 2;
                const friction = col.properties?.find((prop: any) => prop.name == 'friction')?.value;
                if (typeof friction != 'number') throw new TypeError('Invalid or missing friction coefficient for tile ' + tile.id);
                const x = col.x / raw.tilewidth + hw;
                const y = 1 - (col.y / raw.tilewidth + hh);
                collisions.push({
                    x: x,
                    y: y,
                    halfBoundingWidth: hw,
                    halfBoundingHeight: hh,
                    vertices: [
                        { x: x - hw, y: y + hh },
                        { x: x + hw, y: y + hh },
                        { x: x + hw, y: y - hh },
                        { x: x - hw, y: y - hh }
                    ],
                    friction: friction
                });
                rectCount++;
            }
        }
        if (config.debugMode) {
            GameMap.logger.debug(`Spawnpoint tiles: ${[
                ...Array.from(this.playerSpawnpoints.values(), (id) => `${id}->Player`),
                ...Array.from(this.lootboxSpawnpoints.entries(), ([id, type]) => `${id}->Lootbox(${reverse_enum(LootBoxType, type)})`)
            ].join(', ')}`);
            GameMap.logger.debug(`Loaded tileset in ${performance.now() - start}ms, mapped ${rectCount} rectangles`, true);
        }
    }
}

/**
 * Collision entity as part of map, with friction property
 */
export interface MapCollision extends Collidable {
    readonly friction: number;
}

export enum SpawnpointType {
    PLAYER = 'player',
    LOOTBOX = 'lootbox'
}

export default GameMap;