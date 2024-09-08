import fs from 'fs';
import { resolve as pathResolve } from 'path';
import { MessagePort } from 'worker_threads';

export interface Logger {
    /**
     * Get a timestamp in YYYY-MM-DD [HH:MM:SS] format.
     * @returns Timestamp in YYYY-MM-DD [HH:MM:SS] format.
     */
    timestamp(): string
    /**
     * Append a debug-level entry to the log.
     * @param {string} text Text
     * @param {boolean} logOnly Only put in logfile, not stdout
     */
    debug(text: string, logOnly?: boolean): void
    /**
     * Append an information-level entry to the log.
     * @param {string} text Text
     * @param {boolean} logOnly Only put in logfile, not stdout
     */
    info(text: string, logOnly?: boolean): void
    /**
     * Append a warning-level entry to the log.
     * @param {string} text Text
     * @param {boolean} logOnly Only put in logfile, not stdout
     */
    warn(text: string, logOnly?: boolean): void
    /**
     * Append an error-level entry to the log.
     * @param {string} text Text
     * @param {boolean} logOnly Only put in logfile, not stdout
     */
    error(text: string, logOnly?: boolean): void
    /**
     * Append a fatal-level entry to the log.
     * @param {string} text Text
     * @param {boolean} logOnly Only put in logfile, not stdout
     */
    fatal(text: string, logOnly?: boolean): void
    /**
     * Shorthand for appending `Error` objects as error-level logs.
     * @param {string} message Accompanying message
     * @param error `Error` object
     */
    handleError(message: string, error: any): void
    /**
     * Shorthand for appending `Error` objects as fatal-level logs.
     * @param {string} message Accompanying message
     * @param error `Error` object
     */
    handleFatal(message: string, error: any): void
    /**
     * Safely closes the logging session. May be asynchronous to allow pending operations to finish.
     */
    destroy(): void
}

/**
 * A simple logging class with timestamps and logging levels that writes to file and stdout.
 */
export class FileLogger implements Logger {
    private readonly file: number;
    private closed: boolean = false;
    private activity: Set<Promise<void>> = new Set();

    /**
     * Create a new `FileLogger` in a specified directory. Creating a `FileLogger` will also create a
     * `logs/` directory. If there already exists a log.log in the directory, moving it in. This means
     * creating multiple `Loggers` in the same directory will break them.
     * @param {string} path Path to the log directory
     */
    constructor(path: string) {
        path = pathResolve(__dirname, path);
        if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
        const date = new Date();
        let filePath = pathResolve(path, `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}_${date.getUTCHours()}-${date.getUTCMinutes()}-${date.getUTCSeconds()}_log`);
        if (fs.existsSync(filePath + '.log')) {
            let i = 1;
            while (fs.existsSync(filePath + i + '.log')) i++;
            filePath += i;
        }
        this.file = fs.openSync(filePath + '.log', 'a');
        this.info('Logger instance created');
    }

    timestamp(): string {
        const time = new Date();
        let month = (time.getMonth() + 1).toString();
        let day = time.getDate().toString();
        let hour = time.getHours().toString();
        let minute = time.getMinutes().toString();
        let second = time.getSeconds().toString();
        if (month.length == 1) month = 0 + month;
        if (day.length == 1) day = 0 + day;
        if (hour.length == 1) hour = 0 + hour;
        if (minute.length == 1) minute = 0 + minute;
        if (second.length == 1) second = 0 + second;
        return `${time.getFullYear()}-${month}-${day} [${hour}:${minute}:${second}]`;
    }
    debug(text: string, logOnly = false) {
        this.append('debug', text, 36, logOnly);
    }
    info(text: string, logOnly = false) {
        this.append(' info', text, 34, logOnly);
    }
    warn(text: string, logOnly = false) {
        this.append(' warn', text, 33, logOnly);
    }
    error(text: string, logOnly = false) {
        this.append('error', text, 31, logOnly);
    }
    fatal(text: string, logOnly = false) {
        this.append('fatal', text, 35, logOnly);
    }
    handleError(message: string, error: any) {
        this.error(message);
        if (error instanceof Error) {
            this.error(error.message);
            if (error.stack == undefined) Error.captureStackTrace(error);
            if (error.stack) this.error(error.stack);
        } else {
            this.error('' + error);
            const stack: { stack?: string } = {};
            Error.captureStackTrace(stack);
            if (stack.stack) this.error(stack.stack);
        }
    }
    handleFatal(message: string, error: any) {
        this.fatal(message);
        if (error instanceof Error) {
            this.fatal(error.message);
            if (error.stack == undefined) Error.captureStackTrace(error);
            if (error.stack) this.fatal(error.stack);
        } else {
            this.fatal('' + error);
            const stack: { stack?: string } = {};
            Error.captureStackTrace(stack);
            if (stack.stack) this.error(stack.stack);
        }
    }

    private append(level: string, text: string, color: number, logOnly = false) {
        if (this.file == undefined) return;
        if (!logOnly) {
            let prefix1 = `\x1b[0m\x1b[32m${this.timestamp()} \x1b[1m\x1b[${color}m${level.toUpperCase()}\x1b[0m | `;
            process.stdout.write(`${prefix1}${text.toString().replaceAll('\n', `\n\r${prefix1}`)}\n\r`);
        }
        let prefix2 = `${this.timestamp()} ${level.toUpperCase()} | `;
        const fd = this.file;
        const op = new Promise<void>((resolve) => fs.appendFile(fd, `${prefix2}${text.toString().replaceAll('\n', `\n${prefix2}`)}\n`, { encoding: 'utf-8' }, (err) => {
            if (err) console.error(err);
            resolve();
            this.activity.delete(op);
        }));
        this.activity.add(op);
    }

    async destroy() {
        if (this.closed) return;
        this.info('Logger instance destroyed');
        await Promise.all(this.activity);
        fs.closeSync(this.file);
        this.closed = true;
    }
}

/**
 * An extension of any other `Logger` instance that adds a name prefix to all messages.
 */
export class NamedLogger implements Logger {
    readonly logger: Logger;
    readonly name: string;

    /**
     * Create a new `NamedLogger` around an existing `Logger`.
     * @param logger Logger instance to wrap around
     * @param name Name prefix, without brackets
     */
    constructor(logger: Logger, name: string) {
        this.logger = logger;
        this.name = name;
    }

    timestamp(): string {
        return this.logger.timestamp();
    }
    debug(text: string, logOnly = false) {
        this.logger.debug(`[${this.name}] ${text.replaceAll('\n', `\n[${this.name}] `)}`, logOnly);
    }
    info(text: string, logOnly = false) {
        this.logger.info(`[${this.name}] ${text.replaceAll('\n', `\n[${this.name}] `)}`, logOnly);
    }
    warn(text: string, logOnly = false) {
        this.logger.warn(`[${this.name}] ${text.replaceAll('\n', `\n[${this.name}] `)}`, logOnly);
    }
    error(text: string, logOnly = false) {
        this.logger.error(`[${this.name}] ${text.replaceAll('\n', `\n[${this.name}] `)}`, logOnly);
    }
    fatal(text: string, logOnly = false) {
        this.logger.fatal(`[${this.name}] ${text.replaceAll('\n', `\n[${this.name}] `)}`, logOnly);
    }
    handleError(message: string, error: any) {
        this.logger.handleError.call(this, message, error);
    }
    handleFatal(message: string, error: any) {
        this.logger.handleFatal.call(this, message, error);
    }

    async destroy() {
        await this.logger.destroy();
    }
}

/**
 * The reciever that writes to a `Logger` instance in a pair of a `MessageChannelLoggerReciever` and {@link MessageChannelLoggerSender}.
 * Communicates over a `MessageChannel` where the sender and reciever accept the opposite `MessagePort` returned by the `MessageChannel`.
 */
export class MessageChannelLoggerReciever {
    readonly logger: Logger;
    readonly selfLogger: NamedLogger;
    readonly port: MessagePort;

    /**
     * @param {Logger} logger Logger to write to
     * @param {MessagePort} port Corresponding other `MessagePort` of the `MessagePort` being used by a `MessageChannelLoggerSender`
     */
    constructor(logger: Logger, port: MessagePort) {
        this.logger = logger;
        this.selfLogger = new NamedLogger(this.logger, 'MessagePortLoggerReciever');
        this.port = port;
        this.port.on('message', (message: [number, any]) => {
            if (!Array.isArray(message) || message.length != 2 || typeof message[0] != 'number' || !Array.isArray(message[1])) return;
            switch (message[0]) {
                case 0: this.logger.debug(message[1][0], message[1][1]);
                case 1: this.logger.info(message[1][0], message[1][1]);
                case 2: this.logger.warn(message[1][0], message[1][1]);
                case 3: this.logger.error(message[1][0], message[1][1]);
                case 4: this.logger.fatal(message[1][0], message[1][1]);
                case 5: this.logger.handleError(message[1][0], message[1][1]);
                case 6: this.logger.handleFatal(message[1][0], message[1][1]);
                case 7: this.logger.destroy();
                case 8: this.selfLogger.handleError('MessagePort error on remote:', message[1]);
                default: this.selfLogger.error(`Unexpected method "${message[0]}" (payload ${message[1]})`);
            }
        });
        this.port.on('messageerror', (err) => {
            this.selfLogger.handleError('MessagePort error:', err);
        });
        this.port.on('close', () => {
            this.selfLogger.warn('The MessageChannel was unexpectedly closed');
        });
    }
}

/**
 * The sender in a pair of a {@link MessageChannelLoggerReciever} and `MessageChannelLoggerSender.
 * Communicates over a `MessageChannel` where the sender and reciever accept the opposite `MessagePort` returned by the `MessageChannel`.
 * 
 * *Note that log messages will be lost if a `MessageChannelLoggerReciever` is not on the opposite `MessagePort`.*
 */
export class MessageChannelLoggerSender implements Logger {
    readonly port: MessagePort;

    /**
     * @param {MessagePort} port Corresponding other `MessagePort` of the `MessagePort` being used by a `MessageChannelLoggerReciever`
     */
    constructor(port: MessagePort) {
        this.port = port;
        this.port.on('messageerror', (err) => {
            this.port.postMessage([8, err]);
            console.error('MessagePortLoggerSender error:');
            console.error(err);
        });
        this.port.on('close', () => {
            console.warn('MessagePortLoggerSender MessageChannel was unexpectedly closed');
        });
    }

    timestamp(): string {
        const time = new Date();
        let month = (time.getMonth() + 1).toString();
        let day = time.getDate().toString();
        let hour = time.getHours().toString();
        let minute = time.getMinutes().toString();
        let second = time.getSeconds().toString();
        if (month.length == 1) month = 0 + month;
        if (day.length == 1) day = 0 + day;
        if (hour.length == 1) hour = 0 + hour;
        if (minute.length == 1) minute = 0 + minute;
        if (second.length == 1) second = 0 + second;
        return `${time.getFullYear()}-${month}-${day} [${hour}:${minute}:${second}]`;
    }
    debug(text: string, logOnly?: boolean): void {
        this.port.postMessage([0, text, logOnly]);
    }
    info(text: string, logOnly?: boolean): void {
        this.port.postMessage([1, text, logOnly]);
    }
    warn(text: string, logOnly?: boolean): void {
        this.port.postMessage([2, text, logOnly]);
    }
    error(text: string, logOnly?: boolean): void {
        this.port.postMessage([3, text, logOnly]);
    }
    fatal(text: string, logOnly?: boolean): void {
        this.port.postMessage([4, text, logOnly]);
    }
    handleError(message: string, error: any): void {
        this.port.postMessage([5, message, error]);
    }
    handleFatal(message: string, error: any): void {
        this.port.postMessage([6, message, error]);
    }

    async destroy() {
        this.port.postMessage([7]);
    }
}

export default Logger;