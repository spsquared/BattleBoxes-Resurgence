import { isMainThread } from 'worker_threads';
if (!isMainThread) throw new Error('Hub must be run in main thread!');

const start = performance.now();

import fs from 'fs';
import path from 'path';

import { configDotenv } from 'dotenv';
configDotenv({ path: path.resolve(__dirname, '../../config/.env') });
import config from '@/config';

// verify environment variables exist
if (['CONFIG_PATH', 'GAME_SRC_PATH', 'RECAPTCHA_SECRET', ...(!config.useFileDatabase ? ['DATABASE_URL'] : [])].some((v) => process.env[v] == undefined)) {
    throw new Error('Missing environment variables. Make sure your environment is set up correctly!');
}

const configLoadTime = performance.now() - start;

// start server
import { FileLogger, MultiLogger } from '../common/log';
const logger = new MultiLogger([
    new FileLogger(config.logPath),
    new FileLogger(path.resolve(config.logPath, 'recent.log'), false, false)
]);
logger.info('Starting server...');
logger.debug('BASE_PATH: ' + config.path);
logger.debug('GAME_SRC_PATH: ' + config.gameSourcePath);
logger.debug('CONFIG_PATH: ' + config.configPath);
logger.debug('Current config:\n' + JSON.stringify({ ...config, chatBannedWordList: ['not shown'], accessOrigins: config.accessOrigins.map((exp) => exp.source) }, null, 4), true);
if (config.debugMode) logger.info('Extra debug logging is enabled (disable this if this is not a development environment!)');

// set up networking
import express from 'express';
import http from 'http';
import https from 'https';
import { rateLimit } from 'express-rate-limit';
import cors from 'cors';
import cookieParser from 'cookie-parser';
const app = express();
const server = fs.existsSync(path.resolve(config.configPath, 'cert.pem')) ? https.createServer({
    key: fs.readFileSync(path.resolve(config.configPath, 'cert-key.pem')),
    cert: fs.readFileSync(path.resolve(config.configPath, 'cert.pem'))
}, app) : http.createServer(app);
const limiter = rateLimit({
    windowMs: 100,
    max: 100,
    handler: (req, res, next) => {
        logger.warn('Rate limiting triggered by ' + (req.ip ?? req.socket.remoteAddress));
    }
});
app.use(limiter);
app.use(cors({
    origin: config.accessOrigins,
    credentials: true,
    allowedHeaders: 'Content-Type,Cookie'
}));
app.use(cookieParser());
// in case server is not running
app.get('/wakeup', (req, res) => res.json('ok'));

// init modules
import { Server as SocketIOServer } from 'socket.io';
import { PsqlDatabase, FileDatabase } from '../common/database';
const database = config.useFileDatabase ? new FileDatabase({
    logger: logger
}) : new PsqlDatabase({
    uri: process.env.DATABASE_URL!,
    sslCert: process.env.DATABASE_CERT,
    logger: logger
});

// init game
import { GameHostManager } from './hostRunner';
if (config.debugMode) logger.info('Creating Socket.IO server');
const io = new SocketIOServer(server, {
    path: '/game-socketio',
    cors: {
        origin: config.accessOrigins,
        methods: ['GET', 'POST'],
        credentials: true
    }
});
const hostManager = new GameHostManager(io, database, logger);

// complete networking
import { addClientRoutes } from './clients';
addClientRoutes(app, database, hostManager, logger);
// default 404 everything
app.use('/*', (req, res) => res.sendStatus(404));

const instantiationTime = performance.now() - start;

// listen
Promise.all([
    database.connect(),
]).then(() => {
    const startTime = performance.now() - start;
    server.listen(config.port);
    if (config.debugMode) logger.debug(`Config load: ${configLoadTime}ms; Module instantiation: ${instantiationTime}ms`);
    logger.info(`Server started in ${startTime}ms, listening to port ${config.port}`);
});

const stopServer = async (code: number) => {
    logger.info('Stopping server...');
    const start = performance.now();
    let actuallyStop = () => {
        logger.warn('[!] Forced server close! Skipped waiting for shutdown! [!]');
        process.exit(code);
    };
    process.on('SIGTERM', actuallyStop);
    process.on('SIGQUIT', actuallyStop);
    process.on('SIGINT', actuallyStop);
    io.close();
    await Promise.all([
        database.disconnect(),
        ...hostManager.getGames(false).map((host) => host.end())
    ]);
    logger.info(`Server stopped, took ${performance.now() - start}ms`);
    logger.destroy();
    process.exit(code);
};
process.on('SIGTERM', () => stopServer(0));
process.on('SIGQUIT', () => stopServer(0));
process.on('SIGINT', () => stopServer(0));

const handleUncaughtError = (err: any, origin: string | Promise<unknown>) => {
    if (err instanceof Error) {
        logger.fatal(err.message);
        if (err.stack) logger.fatal(err.stack);
    } else if (err != undefined) logger.fatal(err);
    if (typeof origin == 'string') logger.fatal(origin);
    const handleUncaughtError2 = (err: any, origin: string | Promise<unknown>) => {
        console.error('An exception occured while handling another exception:');
        console.error(err);
        if (typeof origin == 'string') console.error(origin);
    };
    process.off('uncaughtException', handleUncaughtError);
    process.off('unhandledRejection', handleUncaughtError);
    process.on('uncaughtException', handleUncaughtError2);
    process.on('unhandledRejection', handleUncaughtError2);
    stopServer(1);
};
process.on('uncaughtException', handleUncaughtError);
process.on('unhandledRejection', handleUncaughtError);