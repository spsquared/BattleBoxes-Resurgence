import { MessagePort } from 'worker_threads';

/**
 * Adds `EventEmitter`-like functionality to `MessagePort` instances.
 * `MessagePortEventEmitter` is required on both ports of the `MessageChannel` to work, and
 * should function even if there are external `message` events send by other code.
 * 
 * `MessagePortEventEmitter` has two reserved events that should not be used: `close` and `error`.
 * These fire when the underlying `MessagePort` emits a `close` or `messageerror` event, respectively.
 * The `error` event carries one argument when fired: an `Error` object.
 */
export class MessagePortEventEmitter {
    private readonly port: MessagePort;
    private readonly listeners: Map<string, Set<(...data: any) => any>> = new Map();

    constructor(messagePort: MessagePort) {
        this.port = messagePort;
        this.port.on('message', (message: [string, any]) => {
            // will ignore malformed messages possibly caused by outside code
            if (!Array.isArray(message) || message.length != 2 || typeof message[0] != 'string' || !Array.isArray(message[1])) return;
            this.listeners.get(message[0])?.forEach((listener) => listener(...message[1]));
        });
        this.port.on('close', () => {
            this.listeners.get('close')?.forEach((listener) => listener());
        });
        this.port.on('messageerror', (err: Error) => {
            this.listeners.get('close')?.forEach((listener) => listener(err));
        });
    }

    /**
     * Emit an event with arbitrary data accompanying it.
     * @param {string} event Event name
     * @param {any} data Any amount of arguments of any type, as long as it is compatible with `MessagePort`'s `postMessage`
     */
    emit(event: string, ...data: any): void {
        this.port.postMessage([event, data]);
    }

    /**
     * Add a listener function for an event.
     * @param {string} event Event name
     * @param {function} listener Listener function (can accept arbitrary number of arguments)
     */
    addEventListener(event: string, listener: (...data: any) => any): void {
        if (this.listeners.has(event)) this.listeners.get(event)!.add(listener);
        else this.listeners.set(event, new Set([listener]));
    }
    /**
     * Remove a listener function for an event, returning if the listener was found and removed.
     * @param {string} event Event name
     * @param {function} listener Listener function (must be the same function passed to {@link addEventListener})
     * @returns {boolean} `true` if the listener function was removed, otherwise `false`
     */
    removeEventListener(event: string, listener: (...data: any) => any): boolean {
        const listeners = this.listeners.get(event);
        const stat = listeners?.delete(listener) == true;
        if (listeners?.size == 0) this.listeners.delete(event);
        return stat;
    }
    /**
     * Remove all listener functions for an event (or all listeners if `event` is `undefined`), returning if any listeners were found and removed.
     * @param {string} event Event name or `undefined`
     * @returns {boolean} `true` if any listener function was removed, otherwise `false`
     */
    removeAllListeners(event?: string): boolean {
        if (event !== undefined) return this.listeners.delete(event);
        const stat = this.listeners.size > 0;
        this.listeners.clear();
        return stat;
    }
    /**
     * Add a listener function for an event.
     * @param {string} event Event name
     * @param {function} listener Listener function (can accept arbitrary number of arguments)
     * @alias {@link addEventListener}
     */
    on(event: string, listener: (...data: any) => any):void {
        this.addEventListener(event, listener);
    }
    /**
     * Remove a listener function for an event, returning if the listener was found and removed.
     * @param {string} event Event name
     * @param {function} listener Listener function (must be the same function passed to {@link addEventListener})
     * @returns {boolean} `true` if the listener function was removed, otherwise `false`
     * @alias {@link removeEventListener}
     */
    off(event: string, listener: (...data: any) => any): boolean {
        return this.removeEventListener(event, listener);
    }
    /**
     * Add a listener function for an event that is only executed once, then removed.
     * @param {string} event Event name
     * @param {function} listener Listener function (can accept arbitrary number of arguments)
     */
    once(event: string, listener: (...data: any) => any): void {
        const l = (...data: any) => {
            listener(...data);
            this.removeEventListener(event, l);
        };
        this.addEventListener(event, l);
    }
    /**
     * Returns all listener functions for an event, or undefined if there are no listeners.
     * @param {string} event Event name
     * @returns {((...data: any) => any)[] | undefined} Array of listener functions or undefined if no listeners
     */
    getEventListeners(event: string): ((...data: any) => any)[] | undefined {
        const listeners = this.listeners.get(event)?.values();
        return listeners !== undefined ? Array.from(listeners) : undefined;
    }
}