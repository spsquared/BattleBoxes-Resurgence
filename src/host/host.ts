import { isMainThread, parentPort } from 'worker_threads';

import { MessageChannelLoggerSender } from '@/common/log';
import { MessageChannelEventEmitter } from '@/common/messageChannelEvents';
import config from '@/config';

if (isMainThread || parentPort == null) throw new Error('Game host must be run in worker thread!');

// set up communications using two MessageChannels
export const parentMessenger = new MessageChannelEventEmitter(parentPort);
const { port1: loggingPort, port2: remoteLoggingPort } = new MessageChannel();
export const logger = new MessageChannelLoggerSender(loggingPort);
parentMessenger.emit('logger', remoteLoggingPort);

parentMessenger.on('error', (err: Error) => {
    logger.handleError('MessagePort error:', err);
});

// create game (everything is static since singletons are annoying)
import { Game } from './game';

Promise.all([
    logger.ready
]).then(() => {
    parentMessenger.emit('ready');
    logger.debug('Host started and game ready');
});

let stopping = false;
export const stopServer = async (code: number) => {
    if (stopping) return;
    stopping = true;
    logger.info('Stopping game host...');
    await Game.stop('Server closed');
    await logger.destroy();
    process.exit(code);
};

const handleUncaughtError = (err: any, origin: string | Promise<unknown>) => {
    if (err instanceof Error) {
        logger.fatal(err.message);
        if (err.stack) logger.fatal(err.stack);
    } else if (err != undefined) logger.fatal(err);
    if (typeof origin == 'string') logger.fatal(origin);
    process.off('uncaughtException', handleUncaughtError);
    process.off('unhandledRejection', handleUncaughtError);
    stopServer(1);
};
process.on('uncaughtException', handleUncaughtError);
process.on('unhandledRejection', handleUncaughtError);

parentMessenger.on('shutdown', () => {
    if (config.debugMode) logger.debug('External exit command recieved', true);
    stopServer(0);
});