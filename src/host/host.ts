import { log } from 'console';
import { isMainThread, parentPort } from 'worker_threads';

import config from '@/common/config';
import { MessageChannelLoggerSender } from '@/common/log';
import { MessageChannelEventEmitter } from '@/common/messageChannelEvents';

if (isMainThread || parentPort == null) throw new Error('Game host must be run in worker thread!');

// set up communications using two MessageChannels
const parentMessenger = new MessageChannelEventEmitter(parentPort);
const { port2: remoteLoggingPort, port1: loggingPort } = new MessageChannel();
const logger = new MessageChannelLoggerSender(loggingPort);
parentMessenger.emit('logger', remoteLoggingPort);

parentMessenger.on('error', (err: Error) => {
    logger.handleError('MessagePort error:', err);
});

const stopServer = async (code: number) => {
    logger.info('Stopping game host...');
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

console.log(config.path, config.scriptPath)