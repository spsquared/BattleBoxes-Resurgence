import { Server as SocketIOServer } from 'socket.io';

/**
 * Room manager that spawns game hosts for each room created.
 */
class HostManager {
    private readonly io: SocketIOServer;

    constructor(io: SocketIOServer) {
        this.io = io;
    }
}