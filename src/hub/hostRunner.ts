import { Server as SocketIOServer, Namespace as SocketIONamespace } from 'socket.io';
import { randomUUID as randomSecureUUID } from 'crypto';

/**
 * Game room manager that creates `GameHost` instances for each room created.
 */
export class GameHostManager {
    private readonly io: SocketIOServer;

    constructor(io: SocketIOServer) {
        this.io = io;
    }
}

/**
 * Room runner that spawns a game subprocess and handles communication with it using `postMessage` events.
 */
export class GameHostRunner {
    private static readonly gameIds: Set<string> = new Set();
    private readonly id: string;
    private readonly io: SocketIONamespace;

    constructor(io: SocketIOServer) {
        // make sure no overlapping ids (counter would prevent this but id is used as game join code) (also 2.1 billion possible join codes oof)
        do {
            this.id = Array.from(new Array(6), () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012346789'.charAt(Math.floor(Math.random() * 36))).join('');
        } while (!GameHostRunner.gameIds.has(this.id));
        GameHostRunner.gameIds.add(this.id);
        this.io = io.of(this.id);
    }

    /**
     * Add a player to the game, returning a verification code the client must use to connect to the game. 
     * @param {string} username Username of player (checks for validity)
     */
    addPlayer(username: string): string {
        // fetch the player data and send to subprocess
        return randomSecureUUID();
    }
}