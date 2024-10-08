import fs from 'fs';
import path from 'path';

process.env.BASE_PATH ??= path.resolve(__dirname, '../');
process.env.SCRIPT_PATH ??= __dirname;
process.env.GAME_SRC_PATH ??= path.resolve(process.env.BASE_PATH, 'game-resources/');
process.env.CONFIG_PATH ??= path.resolve(process.env.BASE_PATH, 'config/');
const certPath = path.resolve(process.env.CONFIG_PATH, 'db-cert.pem');
if (fs.existsSync(certPath)) process.env.DATABASE_CERT = fs.readFileSync(certPath, 'utf8');
const configPath = path.resolve(process.env.CONFIG_PATH, 'config.json');
function loadConfig() {
    try {
        if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, '{}', 'utf8');
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return {};
    }
}
const fileConfig = loadConfig();
/**
 * Global configuration, loaded from `config.json` in the config folder.
 * If any field is empty in `config.json`, it is filled in with the default.
 */
const config: {
    /**TCP port for the HTTP/HTTPS server to listen to (default: 9000) */
    readonly port: string
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
} = {
    port: process.env.PORT ?? fileConfig.port ?? 9000,
    maxConnectPerSecond: fileConfig.maxConnectPerSecond ?? 5,
    maxSignupPerMinute: fileConfig.maxSignupPerMinute ?? 1,
    rsaKeyRotateInterval: fileConfig.rsaKeyRotateInterval ?? 86400000,
    useFileDatabase: fileConfig.useFileDatabase ?? false,
    tokenExpireTime: fileConfig.tokenExpireTime ?? 360,
    sessionExpireTime: fileConfig.sessionExpireTime ?? 60,
    debugMode: process.argv.includes('debug_mode') ?? process.env.DEBUG_MODE ?? fileConfig.debugMode ?? false,
    path: process.env.BASE_PATH,
    scriptPath: process.env.SCRIPT_PATH,
    gameSourcePath: fileConfig.gameSourcePath ?? process.env.GAME_SRC_PATH,
    configPath: process.env.CONFIG_PATH,
    logPath: process.env.LOG_PATH ?? fileConfig.logPath ?? path.resolve(__dirname, '../logs/'),
};
process.env.GAME_SRC_PATH = config.gameSourcePath;
// when writing back to file, prevent environment variables and argument overrides also overwriting file configurations
const config2: any = structuredClone(config);
config2.port = fileConfig.port ?? 2000;
config2.debugMode = fileConfig.debugMode ?? false;
delete config2.path;
delete config2.configPath;
config2.gameSourcePath = fileConfig.gameSourcePath;
config2.logPath = fileConfig.logPath;
try {
    fs.writeFileSync(configPath, JSON.stringify(config2, null, 4));
} catch { }

export default config;