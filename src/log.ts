import fs from 'fs';
import { resolve as pathResolve } from 'path';

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
    #file?: number;
    #activity: Set<Promise<void>> = new Set();

    /**
     * Create a new `FileLogger` in a specified directory. Creating a `FileLogger` will also create a
     * `logs/` directory. If there already exists a log.log in the directory, moving it in. This means
     * creating multiple `Loggers` in the same directory will break them.
     * @param {string} path Path to the log directory
     */
    constructor(path: string) {
        path = pathResolve(__dirname, path);
        if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
        try {
            const date = new Date();
            let filePath = pathResolve(path, `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}_${date.getUTCHours()}-${date.getUTCMinutes()}-${date.getUTCSeconds()}_log`);
            if (fs.existsSync(filePath + '.log')) {
                let i = 1;
                while (fs.existsSync(filePath + i + '.log')) i++;
                filePath += i;
            }
            this.#file = fs.openSync(filePath + '.log', 'a');
            this.info('Logger instance created');
        } catch (err) {
            console.error(err);
        }
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
        this.#append('debug', text, 36, logOnly);
    }
    info(text: string, logOnly = false) {
        this.#append(' info', text, 34, logOnly);
    }
    warn(text: string, logOnly = false) {
        this.#append(' warn', text, 33, logOnly);
    }
    error(text: string, logOnly = false) {
        this.#append('error', text, 31, logOnly);
    }
    fatal(text: string, logOnly = false) {
        this.#append('fatal', text, 35, logOnly);
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

    #append(level: string, text: string, color: number, logOnly = false) {
        if (this.#file == undefined) return;
        if (!logOnly) {
            let prefix1 = `\x1b[0m\x1b[32m${this.timestamp()} \x1b[1m\x1b[${color}m${level.toUpperCase()}\x1b[0m | `;
            process.stdout.write(`${prefix1}${text.toString().replaceAll('\n', `\n\r${prefix1}`)}\n\r`);
        }
        let prefix2 = `${this.timestamp()} ${level.toUpperCase()} | `;
        const fd = this.#file;
        const op = new Promise<void>((resolve) => fs.appendFile(fd, `${prefix2}${text.toString().replaceAll('\n', `\n${prefix2}`)}\n`, { encoding: 'utf-8' }, (err) => {
            if (err) console.error(err);
            resolve();
            this.#activity.delete(op);
        }));
        this.#activity.add(op);
    }

    async destroy() {
        if (this.#file == undefined) return;
        this.info('Logger instance destroyed');
        await Promise.all(this.#activity);
        fs.closeSync(this.#file);
        this.#file = undefined;
    }
}

/**
 * An extension of any other Logger that adds a name prefix to all messages.
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
        this.error(message);
        if (error instanceof Error) {
            this.error(error.message);
            if (error.stack) this.error(error.stack);
        } else {
            this.error('' + error);
        }
    }
    handleFatal(message: string, error: any) {
        this.fatal(message);
        if (error instanceof Error) {
            this.fatal(error.message);
            if (error.stack) this.fatal(error.stack);
        } else {
            this.fatal('' + error);
        }
    }

    async destroy() {
        await this.logger.destroy();
    }
}

export default Logger;