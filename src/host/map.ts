import { readdir, readFile } from 'fs/promises';
import { resolve as pathResolve } from 'path';

import { NamedLogger } from '@/common/log';
import config from '@/config';

import { Collidable } from './entities/entity';
import { logger } from './host';

/**
 * Global map loader that creates and stores collision entities for maps from files found in the game resources.
 */
export class GameMap {
    static readonly maps: Map<string, GameMap> = new Map();
    static current?: GameMap = undefined;
    private static tileset: GameTileset | undefined;

    static readonly logger: NamedLogger = new NamedLogger(logger, 'GameMap');

    readonly width: number;
    readonly height: number;
    readonly collisionGrid: MapCollision[][][];

    /**
     * @param json Raw JSON string from file
     * @param name Unique name/ID of map
     */
    constructor(json: string, name: string) {
        if (config.debugMode) GameMap.logger.debug('Loading ' + name);
        const start = performance.now();
        const raw = JSON.parse(json);
        if (GameMap.tileset === undefined) throw new ReferenceError('Tileset was not loaded before map load');
        this.width = raw.width;
        this.height = raw.height;
        this.collisionGrid = Array.from(new Array(this.height), () => Array.from(new Array(this.width), () => new Array()));
        for (const layer of raw.layers) {
            if (layer.width != this.width || layer.height != this.height || layer.data.length != this.width * this.height) throw new RangeError('Mismatched layer size with map size or data length');
            if (layer.name == 'Spawns') {
                // spawnpoint stuff
            } else {
                // loop through every tile in every layer and add collisions
                for (let i = 0; i < layer.data.length; i++) {
                    const tile = layer.data[i] - 1;
                    const x = i % this.width;
                    const y = this.height - ~~(i / this.width) - 1;
                    if (GameMap.tileset.collisionMaps[tile] == undefined) {
                        if (tile >= 0) GameMap.logger.warn(`Tile with no collision map at (${x}, ${y}) - ${tile}`);
                    } else if (GameMap.tileset.collisionMaps[tile].length > 0) {
                        this.collisionGrid[y][x].push(...GameMap.tileset.collisionMaps[tile].map((col) => ({
                            ...col,
                            x: col.x + x,
                            y: col.y + y,
                        })));
                    }
                }
            }
        }
        GameMap.maps.set(name, this);
        if (config.debugMode) GameMap.logger.debug(`Loaded ${name} in ${performance.now() - start}ms, size ${raw.width}x${raw.height}`, true);
    }

    /**
     * Clears map list and regenerates tileset and maps from file.
     */
    static async reloadMaps() {
        this.logger.info('Reloading maps');
        const start = performance.now();
        const [tilesetJson, mapsJson] = await Promise.all([
            readFile(pathResolve(config.gameSourcePath, 'tileset.json'), { encoding: 'utf8' }),
            Promise.all(await readdir(pathResolve(config.gameSourcePath, 'maps/')).then((mapsList) => mapsList.map(async (map) => [map, await readFile(pathResolve(config.gameSourcePath, 'maps/', map), { encoding: 'utf8' })])))
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

    /**
     * @param json Raw JSON string from file
     */
    constructor(json: string) {
        if (config.debugMode) GameMap.logger.debug('Loading tileset');
        const start = performance.now();
        const raw = JSON.parse(json);
        if (raw.tilewidth != raw.tileheight) throw new RangeError('Non-square tiles in tileset');
        this.collisionMaps = Array.from(new Array(raw.tilecount), () => new Array());
        // convert collision rectangles to collidables for entity collision
        let rectCount = 0;
        for (const tile of raw.tiles) {
            const collisions = this.collisionMaps[tile.id];
            for (const col of tile.objectgroup?.objects) {
                const hw = col.width / raw.tilewidth / 2;
                const hh = col.height / raw.tilewidth / 2;
                const friction = col.properties.find((prop: any) => prop.name == 'friction')?.value;
                if (typeof friction != 'number') throw new TypeError('Invalid or missing friction coefficient for tile ' + tile.id);
                collisions.push({
                    x: col.x / raw.tilewidth + hw,
                    y: 1 - (col.y / raw.tilewidth + hh),
                    halfBoundingWidth: hw,
                    halfBoundingHeight: hh,
                    vertices: [
                        { x: -hw, y: -hh },
                        { x: hw, y: -hh },
                        { x: hw, y: hh },
                        { x: -hw, y: hh }
                    ],
                    friction: friction
                });
                rectCount++;
            }
        }
        if (config.debugMode) GameMap.logger.debug(`Loaded tileset in ${performance.now() - start}ms, mapped ${rectCount} rectangles`, true);
    }
}

export interface MapCollision extends Collidable {
    readonly friction: number;
}

export default GameMap;