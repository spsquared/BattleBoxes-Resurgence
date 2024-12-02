import fs, { existsSync, readFileSync } from 'fs';
import path from 'path';
import { isMainThread, workerData } from 'worker_threads';

// weirdness is for workers - workers will inherit config from main thread

type ServerConfig = {
    /**TCP port for the HTTP/HTTPS server to listen to (default: 9000) */
    readonly port: number
    /**Array of regular expressions to match domains for CORS policy (default: `^https?:\/\/localhost:[0-9]{1,5}`, ex: `^https:\/\/(?:.+\.)*domain\.com`) */
    readonly accessOrigins: RegExp[]
    /**Ratelimiting - how many new Socket.IO connections can be made from any given IP address in 1 second before clients are kicked (default: 5) */
    readonly maxConnectPerSecond: number
    /**Ratelimiting - how many new accounts can be made from any given IP address in 1 minute before clients are kicked (default: 1) */
    readonly maxSignupPerMinute: number
    /**Milliseconds between client RSA keypair rotations (default: 86400000) */
    readonly rsaKeyRotateInterval: number
    /**Use a local file as database instead of a PostgreSQL database (default: false) */
    readonly useFileDatabase: boolean
    /**Time in minutes until authentication tokens expire (default: 360) */
    readonly tokenExpireTime: number
    /**Time in minutes until session tokens expire (default: 60) */
    readonly sessionExpireTime: number
    /**Time in seconds until a pending connection to a game host times out and is removed (default: 10) */
    readonly gameConnectTimeout: number
    /**Maximum number of players per game, including AI bots (default: 8) */
    readonly gameMaxPlayers: number
    /**Maximum number of AI bots per game (default: 4) */
    readonly gameMaxBots: number
    /**Number of subunits to divide each grid unit into for movement physics - larger values are more accurate but slower. **Small values cause inconsistent collisions!** (default: 64) */
    readonly gamePhysicsResolution: number
    /**Minimum amount of time in milliseconds between chat messages before a spam infraction is counted (default: 3000) */
    readonly chatMinMillisPerMessage: number
    /**Number of chat messages to allow consecutive violation of `chatMinSecondsPerMessage` before counting infractions (default: 2) */
    readonly chatSpamGraceCount: number
    /**Maximum number of spam or profanity infractions within one minute before player is kicked (default: 5) */
    readonly chatMaxSpamPerMinute: number
    /**Array of banned words in chat, found in `banned-words.csv` in the `CONFIG_PATH` directory - if blank no* words are banned */
    readonly chatBannedWordList: string[]
    /**Enable debug logging (default: false) */
    readonly debugMode: boolean
    /**Marks the path of the directory the server is installed in. Same as the `BASE_PATH` environment variable (this cannot be edited in `config.json``) */
    readonly path: string
    /**Marks the path of the running script. Same as the `SCRIPT_PATH` environment variable (this cannot be edited in `config.json``) */
    readonly scriptPath: string
    /**Marks the path of the configuration files. Same as the `CONFIG_PATH` environment variable (this cannot be edited in `config.json``) */
    readonly configPath: string
    /**Marks hte path of the game resources. Same as the `GAME_SRC_PATH` environment variable (default: `../game-resources/`) */
    readonly gameSourcePath: string
    /**Directory to write logs to - server will also create a `logs` directory there (default: `../`) */
    readonly logPath: string
}

const getConfig = (): any => {
    if (isMainThread) {
        process.env.BASE_PATH ??= path.resolve(__dirname, '../');
        process.env.SCRIPT_PATH ??= __dirname;
        process.env.GAME_SRC_PATH ??= path.resolve(process.env.BASE_PATH, 'game-resources/');
        process.env.CONFIG_PATH ??= path.resolve(process.env.BASE_PATH, 'config/');
        const certPath = path.resolve(process.env.CONFIG_PATH, 'db-cert.pem');
        if (fs.existsSync(certPath)) process.env.DATABASE_CERT = fs.readFileSync(certPath, 'utf8');
        const configPath = path.resolve(process.env.CONFIG_PATH, 'config.json');
        try {
            if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, '{}', 'utf8');
            return JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {
            return {};
        }
    } else {
        process.env.BASE_PATH ??= (workerData as ServerConfig).path;
        process.env.SCRIPT_PATH ??= (workerData as ServerConfig).scriptPath;
        process.env.GAME_SRC_PATH ??= (workerData as ServerConfig).gameSourcePath;
        process.env.CONFIG_PATH ??= (workerData as ServerConfig).configPath;
        return workerData as ServerConfig;
    }
};

const fileConfig = getConfig();
const bannedWordsSrc = path.resolve(process.env.CONFIG_PATH!, 'banned-words.csv');

const ensureNumber = (input: any): number => {
    const n = Number(input);
    if (isNaN(n)) throw new TypeError('Config option must be a number');
    return n;
};

/**
 * Global configuration, loaded from `config.json` in the config folder.
 * If any field is empty in `config.json`, it is filled in with the default.
 * 
 * In worker threads, this is supplied by the global `workerData` from the host server.
 */
const config: ServerConfig = isMainThread ? {
    port: ensureNumber(process.env.PORT ?? fileConfig.port ?? 9000),
    accessOrigins: fileConfig.accessOrigins == null ? [/^https?:\/\/localhost:[0-9]{1,5}/] : Array.from(fileConfig.accessOrigins).reduce<RegExp[]>((arr, reg: any) => {
        try {
            arr.push(new RegExp(reg));
        } catch (err) {
            console.error('Invalid regular expression for accessOrigins');
            console.error(err);
        }
        return arr;
    }, []),
    maxConnectPerSecond: ensureNumber(fileConfig.maxConnectPerSecond ?? 5),
    maxSignupPerMinute: ensureNumber(fileConfig.maxSignupPerMinute ?? 1),
    rsaKeyRotateInterval: ensureNumber(fileConfig.rsaKeyRotateInterval ?? 86400000),
    useFileDatabase: (fileConfig.useFileDatabase ?? false) && true,
    tokenExpireTime: ensureNumber(fileConfig.tokenExpireTime ?? 360),
    sessionExpireTime: ensureNumber(fileConfig.sessionExpireTime ?? 60),
    debugMode: (process.argv.includes('debug_mode') ?? process.env.DEBUG_MODE ?? fileConfig.debugMode ?? false) && true,
    gameConnectTimeout: ensureNumber(fileConfig.gameConnectTimeout ?? 10),
    gameMaxPlayers: ensureNumber(fileConfig.maxPlayers ?? 8),
    gameMaxBots: ensureNumber(fileConfig.maxBots ?? 5),
    gamePhysicsResolution: ensureNumber(fileConfig.gamePhysicsResolution ?? 64),
    chatMinMillisPerMessage: ensureNumber(fileConfig.chatMinMillisPerMessage ?? 3000),
    chatSpamGraceCount: ensureNumber(fileConfig.chatSpamGraceCount ?? 2),
    chatMaxSpamPerMinute: ensureNumber(fileConfig.chatMaxSpamPerMinute ?? 5),
    chatBannedWordList: existsSync(bannedWordsSrc) ? readFileSync(bannedWordsSrc, 'utf8').split(/[,\n]/).filter((s) => s.length > 0) : [],
    path: process.env.BASE_PATH!,
    scriptPath: process.env.SCRIPT_PATH!,
    gameSourcePath: fileConfig.gameSourcePath ?? process.env.GAME_SRC_PATH!,
    configPath: process.env.CONFIG_PATH!,
    logPath: (process.env.LOG_PATH ?? fileConfig.logPath ?? path.resolve(__dirname, '../logs/')) + '',
} satisfies ServerConfig : fileConfig;

if (isMainThread) {
    process.env.GAME_SRC_PATH = config.gameSourcePath;
    // when writing back to file, prevent environment variables and argument overrides also overwriting file configurations
    const config2: any = structuredClone(config);
    config2.port = fileConfig.port ?? 9000;
    config2.accessOrigins = config.accessOrigins.map((exp) => exp.source);
    config2.debugMode = fileConfig.debugMode ?? false;
    delete config2.chatBannedWordList;
    delete config2.path;
    delete config2.scriptPath;
    delete config2.configPath;
    config2.gameSourcePath = fileConfig.gameSourcePath;
    config2.logPath = fileConfig.logPath;
    try {
        fs.writeFileSync(path.resolve(process.env.CONFIG_PATH!, 'config.json'), JSON.stringify(config2, null, 4));
    } catch { }
}

export default config;